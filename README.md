# 📘 xcraft-core-cryo

## Aperçu

Le module `xcraft-core-cryo` est la couche de persistance de l'écosystème Xcraft, basée sur SQLite. Il implémente un système d'_event sourcing_ (« action store ») : les actions des acteurs Goblin et Elf sont gelées (`freeze`) dans une base SQLite, puis dégelées (`thaw`) pour reconstruire leur état. Il offre également des fonctionnalités avancées : recherche plein texte (FTS5), recherche vectorielle (extension `sqlite-vector`, distance cosinus), synchronisation distribuée par `commitId`, bootstrap depuis un flux distant, nettoyage des données obsolètes (`SoulSweeper`) et publication optionnelle des actions vers Google Cloud Pub/Sub.

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Configuration avancée](#configuration-avancée)
- [Détails des sources](#détails-des-sources)
- [Licence](#licence)

## Structure du module

- **`cryo.js`** (racine) : point d'entrée qui expose les commandes sur le bus Xcraft (`xcraftCommands`) et charge les endpoints configurés.
- **`lib/cryo.js`** : classe principale `Cryo`, qui hérite de `SQLite` ([xcraft-core-book]).
- **`lib/index.js`** : instance singleton de `Cryo`, configurée via [xcraft-core-etc].
- **`lib/soulSweeper.js`** : nettoyage et optimisation des bases.
- **`lib/streamSQL.js`** : streams `ReadableSQL` et `WritableSQL` pour lire/écrire des lignes SQLite par lots.
- **`lib/streamPort.js`** : streams `MessagePortReadable` et `MessagePortWritable` pour le transfert de données entre threads, avec contre-pression et _watchdog_.
- **`lib/sqlite-vector/loader.js`** : chargement et initialisation de l'extension vectorielle.
- **`lib/endpoints/googleQueue.js`** : endpoint optionnel vers Google Cloud Pub/Sub.
- **`lib/workers/insert.js`** : worker Piscina d'écriture (peuplement FTS/VEC, embeddings, bootstrap).
- **`lib/workers/retrieve.js`** : worker Piscina de lecture streamée des actions `persist`.

## Fonctionnement global

Cryo n'est pas un acteur : c'est un service exposé sous forme de commandes sur le bus Xcraft. Chaque méthode publique de la classe `Cryo` devient une commande `cryo.<méthode>`.

### Principe d'event sourcing

1. **Persistance** : les actions sont gelées (`freeze`) dans la table `actions`.
2. **Récupération** : `thaw` retourne, pour chaque goblin, la dernière action jusqu'à un timestamp donné.
3. **Historique** : les actions intermédiaires sont conservées (mode `all`) ou supprimées au fur et à mesure (mode `last`).
4. **Nettoyage** : le `SoulSweeper` élimine périodiquement l'historique excédentaire.

### Table `actions`

- `rowid` : clé primaire auto-incrémentée (un index explicite supplémentaire accélère les comptages par plages de `rowid`).
- `timestamp` : horodatage ISO de l'action.
- `goblin` : identifiant de l'acteur (ex : `myEntity-myEntity@1`).
- `action` : contenu JSON.
- `version` : version de l'application au moment de la persistance.
- `type` : type d'action (`create`, `persist`, etc.).
- `commitId` : identifiant de commit pour la synchronisation (`NULL` si non synchronisé).

Des index sont créés sur `(goblin, type)`, `(goblin) WHERE commitId IS NULL`, `(goblin, timestamp DESC)`, `timestamp`, `type`, `commitId` et `rowid`.

### Cycle d'une commande

Pour chaque commande, `cryo.js` :

1. appelle la méthode de l'instance `Cryo` ;
2. transmet le résultat à chaque endpoint actif qui possède une méthode du même nom ;
3. envoie `cryo.<commande>.<msgId>.finished` avec le résultat, ou `cryo.<commande>.<msgId>.error` (`code`, `message`, `stack`) en cas d'exception.

Cas particulier de `freeze` : l'événement `finished` ne contient que `{action}` pour une action de type `persist`, et `undefined` sinon.

### Ouverture d'une base

À la première utilisation d'une base (`_open`), Cryo :

- applique les PRAGMA (`case_sensitive_like`, `journal_mode`, et `synchronous = NORMAL` en mode WAL) ;
- crée les tables et index nécessaires, selon la configuration ;
- exécute les migrations de schéma (`PRAGMA user_version`, version courante : 12) ;
- supprime les goblins obsolètes listés dans `migrations.cleanings` ;
- instancie un `SoulSweeper` dédié.

### Fonctionnalités avancées

**Recherche plein texte (FTS5)** — Avec `enableFTS`, une table `lastPersistedActions` conserve la dernière action `persist` par goblin (les entités au statut `trashed` en sont retirées). La table virtuelle `fts_idx` indexe le champ `meta.index` de l'état. Des triggers SQL maintiennent ces tables et appellent les fonctions `onInsertLastAction`, `onUpdateLastAction` et `onDeleteLastAction`, qui publient des événements sur des topics enregistrés via `registerLastActionTriggers`. Pendant une transaction, ces notifications sont mises en attente puis envoyées après le `commit`. La liste `fts.list` permet de restreindre FTS à certaines bases.

**Recherche vectorielle (VEC)** — Avec `enableVEC` (qui exige `enableFTS`), une table ordinaire `embeddings` stocke les vecteurs (`locale`, `scope`, `documentId`, `chunkId`, `chunk`, `embedding`). L'extension `sqlite-vector` est chargée, puis initialisée avec la dimension, le type (`FLOAT32` ou `INT8` selon `vecFunc`) et la distance `COSINE`. La table `embeddingsIndex` associe chaque document au `rowid` de son `persist` le plus récent, ce qui permet de détecter les embeddings obsolètes. Pour les bases persistantes (sans préfixe `.`), Cryo enregistre des triggers sur l'actorType `indexedContent` : chaque insertion ou mise à jour déclenche le topic `<worker-vec-embed>`, traité par un worker Piscina. À l'inverse, la suppression d'une entrée de `lastPersistedActions` supprime ses embeddings par trigger SQL. La liste `vec.list` restreint VEC à certaines bases.

**Transactions et verrous** — `begin`, `immediate` et `exclusive` acquièrent un mutex par base (`_syncLock`) ; `commit` et `rollback` le libèrent.

**Middlewares** — Un middleware prend des lignes et retourne zéro à N lignes. Les middlewares sont chaînés et appliqués par `thaw` (utile pour migrer les modèles de données).

**Synchronisation distribuée** — Les `commitId` tracent l'état de chaque action. Flux : `getDataForSync` → `prepareDataForSync` (marquage avec le commitId zéro `00000000-0000-0000-0000-000000000000`) → `updateActionsAfterSync` (commitId définitif du serveur). L'activation de `actionsSync.enable` dans la configuration de [xcraft-core-goblin] détermine si le `SoulSweeper` ne considère que les actions avec `commitId`.

**Bootstrap** — `bootstrapActions` crée une base temporaire préfixée par un point, la remplit depuis un flux distant, la peuple (FTS/VEC) puis remplace la base principale. Les actions locales en attente sont préservées lorsque l'option `rename` est active.

**Table temporelle** — Avec `enableTimetable`, une table `timetable` précalculée de 64 000 jours (depuis le 2000-01-01) est créée pour des analyses chronologiques.

### Flux de traitement des embeddings

```
Action persist insérée (goblin de type indexedContent)
    → Trigger SQL sur lastPersistedActions (onInsert / onUpdate)
    → Notification sur le topic <worker-vec-embed>
    → Souscription resp.events → Piscina.run({name: 'embed'})
    → Worker : suppression puis insertion dans embeddings + embeddingsIndex
```

## Exemples d'utilisation

### Vérification et initialisation d'une base

```javascript
async cryoStuff() {
  const cryo = this.quest.getAPI('cryo');

  const result = await cryo.isEmpty({db: 'myDatabase'});
  console.log(result); // {exists: true, empty: false}

  const ok = await cryo.init({db: 'myDatabase'});
}
```

### Persistance d'une action

```javascript
async freezeSomething() {
  const cryo = this.quest.getAPI('cryo');

  await cryo.freeze({
    db: 'myDatabase',
    action: {
      type: 'persist',
      payload: {
        state: {
          id: 'myEntity@1',
          meta: {
            status: 'published',
            index: 'contenu indexable pour FTS',
            locale: 'fr',
            vectors: {
              chunk1: {
                chunk: 'Premier morceau de texte',
                embedding: 'deadbeef...', // hexadécimal
              },
            },
          },
        },
      },
    },
    rules: {
      goblin: 'myEntity-myEntity@1',
      mode: 'last', // ne conserve que la dernière action
    },
  });
}
```

### Récupération des actions

```javascript
async thawSomething() {
  const cryo = this.quest.getAPI('cryo');

  // Les lignes arrivent par événements 'cryo.thawed.myDatabase'
  const count = await cryo.thaw({
    db: 'myDatabase',
    timestamp: '2023-05-01T12:00:00.000Z',
  });

  // Récupération partielle par type
  const partial = await cryo.thaw({
    db: 'myDatabase',
    timestamp: '2023-05-01T12:00:00.000Z',
    type: 'myEntity',
    length: 100,
    offset: 0,
  });
}
```

### Utilisation des transactions

```javascript
async withTransaction() {
  const cryo = this.quest.getAPI('cryo');

  await cryo.immediate({db: 'myDatabase'});
  try {
    await cryo.freeze({
      db: 'myDatabase',
      action: {type: 'persist', payload: {/* ... */}},
      rules: {goblin: 'myEntity-myEntity@1', mode: 'last'},
    });
    await cryo.commit({db: 'myDatabase'});
  } catch (error) {
    await cryo.rollback({db: 'myDatabase'});
    throw error;
  }
}
```

### Bootstrap depuis un flux distant

```javascript
async bootstrapDatabase(streamId, routingKey, count) {
  const cryo = this.quest.getAPI('cryo');

  await cryo.bootstrapActions({
    db: 'myDatabase',
    streamId,
    routingKey,
    rename: true, // archive l'ancienne base en .old avant remplacement
    count,        // nombre total d'actions, pour la progression
  });
}
```

### Nettoyage des données obsolètes

```javascript
async cleanupDatabase() {
  const cryo = this.quest.getAPI('cryo');

  // Stratégie combinée : max 10 persists (défaut) + 1 persist au-delà de 30 jours (défaut)
  const changes = await cryo.sweep({dbs: ['myDatabase']});
  console.log(changes); // {myDatabase: 1234}

  await cryo.sweep({dbs: ['myDatabase'], max: 5, days: 15});

  // Ne garder que les 5 derniers persists par goblin
  await cryo.sweepByMaxCount({dbs: ['myDatabase'], max: 5});
}
```

### Synchronisation distribuée

```javascript
async syncData() {
  const cryo = this.quest.getAPI('cryo');

  const {stagedActions, commitIds} = await cryo.getDataForSync({db: 'myDatabase'});

  // Marquer les actions « en transit » avec le commitId zéro
  await cryo.prepareDataForSync({
    db: 'myDatabase',
    rows: stagedActions.map((a) => a.rowid),
    zero: true,
  });

  // Après confirmation du serveur
  await cryo.updateActionsAfterSync({
    db: 'myDatabase',
    serverCommitId: 'abc123-def456-...',
    rows: stagedActions.map((a) => a.rowid),
  });
}
```

### Récupération streamée de persists

```javascript
async syncPersists() {
  const cryo = this.quest.getAPI('cryo');

  const {xcraftStream, routingKey, count} = await cryo.getAllPersist({
    db: 'myDatabase',
  });

  const range = await cryo.getPersistFromRange({
    db: 'myDatabase',
    fromCommitId: 'uuid-from',
    toCommitId: 'uuid-to',
    toInclusive: true,
  });
}
```

## Interactions avec d'autres modules

- **[xcraft-core-book]** : fournit la classe `SQLite` dont `Cryo` hérite (ouverture, requêtes préparées, migrations).
- **[xcraft-core-utils]** : mutex (`locks.getMutex`) et utilitaires JS.
- **[xcraft-core-fs]** : copie, listing et suppression des fichiers de base.
- **[xcraft-core-transport]** : `Streamer` pour la réception des flux lors du bootstrap.
- **[xcraft-core-etc]** : chargement de la configuration de Cryo, de `xcraft` (`xcraftRoot`) et de `xcraft-core-goblin` (`actionsSync.enable`).
- **[xcraft-core-goblin]** : les acteurs utilisent Cryo pour persister leur état via le bus.
- **[xcraft-core-host]** : `appVersion`, `resourcesPath` et `getRoutingKey()`.
- **[xcraft-core-log]** : journalisation du `SoulSweeper`.
- **[xcraft-core-server]** : découvre `cryo.js` au démarrage et charge ses commandes sur le bus.
- **`@google-cloud/pubsub`** : dépendance optionnelle (peer) pour l'endpoint `googleQueue`.
- **`@sqliteai/sqlite-vector`**, **`piscina`**, **`gigawatts`**, **`safe-stable-stringify`** : extension vectorielle, workers, génération asynchrone et sérialisation stable des actions.

## Configuration avancée

| Option                       | Description                                                    | Type    | Valeur par défaut |
| ---------------------------- | -------------------------------------------------------------- | ------- | ----------------- |
| `journal`                    | Mode journal SQLite (`journal` ou `WAL`)                       | String  | `"WAL"`           |
| `endpoints`                  | Endpoints à activer                                            | Array   | `[]`              |
| `enableFTS`                  | Active la recherche plein texte                                | Boolean | `false`           |
| `enableVEC`                  | Active la recherche vectorielle (nécessite `enableFTS`)        | Boolean | `false`           |
| `fts.list`                   | Bases où activer FTS (toutes si vide)                          | Array   | `[]`              |
| `vec.list`                   | Bases où activer VEC (toutes si vide)                          | Array   | `[]`              |
| `vec.dimensions`             | Nombre de dimensions des embeddings                            | Number  | `4096`            |
| `vec.vecFunc`                | Type de vecteur (`vec_f32` → FLOAT32, `vec_int8` → INT8)       | String  | `"vec_f32"`       |
| `vec.defaultLocale`          | Locale par défaut pour le partitionnement des vecteurs         | String  | `"fr"`            |
| `migrations.cleanings`       | Types de goblins à supprimer, par nom de base                  | Object  | `null`            |
| `enableTimetable`            | Active la table `timetable`                                    | Boolean | `false`           |
| `workers.streamPort.timeout` | Délai (ms) sans demande du lecteur avant destruction du writer | Number  | `120000`          |
| `googleQueue.topic`          | Topic Pub/Sub de publication                                   | String  | `""`              |
| `googleQueue.authFile`       | Fichier d'authentification Google, relatif à `resourcesPath`   | String  | `""`              |
| `googleQueue.orderingPrefix` | Partie fixe de la clé d'ordonnancement                         | String  | `""`              |

### Variables d'environnement

| Variable                         | Description                                                                  | Exemple                               | Valeur par défaut |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- | ----------------- |
| `GOOGLE_APPLICATION_CREDENTIALS` | Fichier d'authentification Google Cloud, défini par l'endpoint `googleQueue` | `/app/resources/gcp-credentials.json` | —                 |

## Détails des sources

### `cryo.js` — Point d'entrée et commandes

Façade entre le bus Xcraft et la classe `Cryo`. Au chargement, il instancie les endpoints présents dans `lib/endpoints` et listés dans `endpoints`. Toutes les méthodes publiques (hors constructeur et noms préfixés par `_`) de `Cryo.prototype` deviennent des handlers de commandes, y compris `dispose`. Les commandes déclarées dans `rc` sont toutes `parallel`. Les entrées `close` et `timestamp` de `rc` correspondent à des méthodes héritées de `SQLite` : aucun handler n'est généré pour elles par ce mécanisme.

La fonction `dispose` exportée appelle `cryo.dispose()`.

### `lib/cryo.js` — Classe `Cryo`

#### Initialisation

Le constructeur détermine le répertoire (`<xcraftRoot>/var/cryo` par défaut), la version applicative (`xcraft-core-host`, ou `unknown`) et prépare les DDL et requêtes selon la configuration. `watt.wrapAll(this)` rend les générateurs utilisables de façon asynchrone.

La migration de schéma est incrémentale jusqu'à `user_version = 12` : ajout des colonnes `version`, `type`, `commitId` ; suppression des colonnes `hash`, `source`, `uuid`, de la table `blobs`, des anciens triggers et index ; création de l'index explicite sur `rowid`.

#### Workers Piscina

- **`_piscina(db)`** : un pool par base (1 thread, inactivité 1 s) pour `populate`, `embed`, `refreshEmbeddings` et `bootstrap`.
- **`_piscinaSync`** : pool partagé (0 à N threads, inactivité 30 s) pour `getAllPersist` et `getPersistFromRange`.

#### Méthodes publiques

- **`freeze(resp, msg)`** — Persiste une action (`db`, `action`, `rules: {goblin, mode}`, `raw`). Les modes supportés sont `all` et `last` (avec `commitId`, supprime l'historique antérieur). Pour un `persist` sans `commitId`, si l'état est identique au dernier persist, les actions intermédiaires sont annulées (`revert`) et rien n'est ajouté. Une action `raw` est ignorée si la dernière action du goblin n'est pas un `persist`. En cas d'erreur, retourne `null` (non fatal).
- **`thaw(resp, msg)`** — Envoie sur `cryo.thawed.<db>` la dernière action par goblin jusqu'à `timestamp`, après application des middlewares. Pagination via `type`, `length`, `offset`. Retourne le nombre de lignes lues.
- **`frozen(resp, msg)`** — Nombre d'actions et timestamp, avec filtre optionnel par `type`.
- **`isEmpty(resp, msg)`** — Retourne `{exists, empty}`.
- **`init(resp, msg)`** — Ouvre la base ; si VEC est actif, lance une seule fois en arrière-plan le rafraîchissement des embeddings.
- **`begin(resp, msg)`** / **`immediate(resp, msg)`** / **`exclusive(resp, msg)`** — Démarrent une transaction après acquisition du mutex de la base.
- **`commit(resp, msg)`** — Valide, envoie les notifications en attente puis libère le mutex.
- **`rollback(resp, msg)`** — Annule et libère le mutex.
- **`restore(resp, msg)`** — Copie `dbSrc` vers `dbDst` (ou vers une base branchée si identiques) puis supprime les actions postérieures à `timestamp`.
- **`branch(resp, msg)`** — Renomme la base avec un suffixe horodaté.
- **`getBranchedDbName(db)`** — Retourne le nom de base horodaté.
- **`dump(resp, msg)`** — Copie les dernières actions par goblin jusqu'à un timestamp vers une base externe (`ATTACH DATABASE`). La table de destination utilise un schéma historique.
- **`registerLastActionTriggers(resp, msg)`** / **`unregisterLastActionTriggers(resp, msg)`** — Gèrent les topics (`onInsertTopic`, `onUpdateTopic`, `onDeleteTopic`) par actorType. Nécessitent `enableFTS`.
- **`actions(resp, msg)`** — Envoie sur `cryo.actions.<db>` les `{timestamp, goblin}` d'une plage `from`–`to`.
- **`getEntityTypeCount(resp, msg)`** — Retourne `[{type, count}]`.
- **`branches(resp)`** — Liste les bases et leurs branches : `{[db]: {branches: [timestamp]}}`.
- **`isAlreadyCreated(resp, msg)`** — `true` si le goblin a un `persist`, ou plus d'une action `create`.
- **`hasGoblin(resp, msg)`** — Présence d'au moins une action pour le goblin.
- **`loadMiddleware(resp, msg)`** — Charge un middleware (`middlewarePath`) et l'ajoute à la chaîne, une seule fois.
- **`getDataForSync(resp, msg)`** — Retourne `{stagedActions, commitIds}` (commitIds : dernier, 10ᵉ, 100ᵉ, 200ᵉ, 1000ᵉ).
- **`prepareDataForSync(resp, msg)`** — Marque des lignes (`rows`) avec le commitId zéro (si `zero`) ou `NULL`.
- **`updateActionsAfterSync(resp, msg)`** — Applique `serverCommitId` aux lignes confirmées.
- **`getAllStagedActions(resp, msg)`** / **`getZeroActions(resp, msg)`** — Actions en attente / marquées avec le commitId zéro.
- **`countPersistsFrom(resp, msg)`** / **`countNewPersistsFrom(resp, msg)`** — Comptage des persists (total ou depuis un `commitId`).
- **`hasCommitId(resp, msg)`** / **`getLastCommitId(resp, msg)`** / **`getSomeCommitIds(resp, msg)`** — Négociation de synchronisation.
- **`getPersistFromRange(resp, msg)`** — Retourne `{xcraftStream, routingKey}`, alimenté par le worker `retrieve`.
- **`getAllPersist(resp, msg)`** — Retourne `{xcraftStream, routingKey, count}` (ou `{count}` si aucun persist).
- **`bootstrapActions(resp, msg, next)`** — Générateur watt : reçoit un flux (`streamId`, `routingKey`) vers une base `.<db>`, émet `cryo.bootstrapActions.progress` (`{pos, max}`), réinjecte les actions locales en attente, peuple FTS/VEC, puis remplace la base. Nettoie la base temporaire en cas d'erreur.
- **`getActionsByIds(resp, msg)`** — Dernier persist des goblins donnés.
- **`hasActions(resp, msg)`** — Vérifie que tous les goblins donnés ont un persist.
- **`revert(resp, msg)`** — Supprime les actions non commitées après le dernier persist d'un goblin.
- **`sweep(resp, msg)`** — Exécute `sweepForDays(days=30, max=10)` sur `dbs` (ou toutes les bases). Retourne `{[db]: changes}`.
- **`sweepByMaxCount(resp, msg)`** — Exécute `sweepByCount(max)` sur `dbs` (ou toutes).
- **`refreshEmbeddings(resp, msg)`** — Rafraîchit les embeddings des bases VEC.
- **`usable()`** / **`getLocation()`** — Disponibilité de SQLite / répertoire de stockage.
- **`dispose()`** — Ferme les pools, désabonne les embeddings, lance `PRAGMA optimize` puis `super.dispose()`.

### `lib/soulSweeper.js` — Nettoyage des actions

Instancié par base ; le paramètre `withCommits` (déduit de `actionsSync.enable`) limite le nettoyage aux persists ayant un `commitId`.

- **`sweepByCount(count=4, dryrun=true)`** — Conserve les `count` derniers persists par goblin (1 à 100, erreur sinon) et les actions intermédiaires entre eux. Exécute `ANALYZE` avant et `VACUUM` après si au moins 100 000 lignes sont supprimées.
- **`sweepByDatetime(datetime=now, dryrun=true)`** — Supprime l'historique antérieur à `datetime`, en conservant le persist le plus récent avant cette date et tout ce qui suit.
- **`sweepForDays(days=30, max=10, dryrun=true)`** — Enchaîne `sweepByCount(max)` puis `sweepByDatetime(now - days)` et retourne le cumul.

Avec `dryrun=true`, seul le nombre de lignes concernées est calculé.

### `lib/streamSQL.js` — Streaming SQL

- **`ReadableSQL`** — Lit un itérateur de requête par lots de 64 lignes sérialisés en JSON ; supporte une fonction `wait` et `abort()`.
- **`WritableSQL`** — Insère les lignes en masse ; ouvre une transaction à la construction, la valide et en rouvre une tous les `step` chunks (défaut 1024), et accepte un callback de progression.

### `lib/streamPort.js` — Streaming par `MessagePort`

- **`MessagePortWritable`** — Envoie les chunks selon la demande du lecteur (contre-pression), tente le transfert zero-copy puis la copie. Un watchdog (vérification toutes les 10 s) détruit le stream avec `WriterTimeoutError` si le lecteur est silencieux plus de `workers.streamPort.timeout` ms.
- **`MessagePortReadable`** — Reçoit les chunks, envoie une demande à chaque lecture et propage les erreurs transmises par le writer.

### `lib/index.js` — Instance singleton

Exporte l'instance unique de `Cryo`.

### `lib/endpoints/googleQueue.js` — Google Pub/Sub

Activé en ajoutant `googleQueue` à `endpoints`. Définit `GOOGLE_APPLICATION_CREDENTIALS` à partir de `resourcesPath` et `authFile`.

- **`freeze(resp, msg, results)`** — Publie le résultat avec les attributs `origin`, `publish_timestamp`, et (si présents) `timestamp`, `goblin`, `version`, avec ordonnancement des messages. Une erreur de publication est journalisée sans interrompre le flux.

### `lib/sqlite-vector/loader.js` — Extension vectorielle

- **`getLoadablePath()`** — Chemin de l'extension native (gère `app.asar.unpacked` pour Electron).
- **`load(db)`** — Charge l'extension.
- **`initialize(db, {dimensions, vecFunc})`** — Appelle `vector_init` sur `embeddings.embedding` (type `INT8` si `vec_int8`, sinon `FLOAT32`, distance `COSINE`).

### `lib/workers/insert.js` — Worker d'écriture

- **`populate(...)`** — Peuple `fts_idx` et, si VEC est actif, `embeddings` et `embeddingsIndex`, puis crée les index et lance `ANALYZE`.
- **`embed(...)`** — Remplace les embeddings d'un document dans une transaction `IMMEDIATE`.
- **`refreshEmbeddings(...)`** — Supprime et réinsère les embeddings dont l'entrée de `embeddingsIndex` ne correspond plus au dernier persist.
- **`bootstrap({port, location, db})`** — Reçoit les lignes via `MessagePortReadable` et les insère avec `WritableSQL` (pas de 64).

Les erreurs sont journalisées sur la console et les connexions SQLite sont toujours libérées.

### `lib/workers/retrieve.js` — Worker de lecture

Ouvre la base en lecture seule et envoie les résultats via `ReadableSQL` et `MessagePortWritable`.

- **`getAllPersist(...)`** — Dernier persist avec `commitId` non nul par goblin.
- **`getPersistFromRange(...)`** — Sans `fromCommitId`, derniers persists jusqu'à `toCommitId` ; sinon derniers persists de la plage, avec ou sans le `toCommitId` selon `toInclusive`.

### Tests

- **`test/soulSweeper.spec.js`** — Un bloc d'intégration désactivé (`describe.skip`, base réelle `cms.db`) et des tests unitaires sur base mémoire : conservation des `count` derniers persists, préservation des actions intermédiaires, effet de `withCommits`, bornes de `count`, base vide, goblin sous le seuil.
- **`test/vector.spec.js`** — Vérifie que `embeddings` est une table ordinaire, la recherche par distance cosinus (`vector_full_scan`), le filtrage par `locale` et `scope`, et la suppression des embeddings d'un document.

## Licence

Ce module est distribué sous [licence MIT](./LICENSE).

---

[xcraft-core-book]: https://github.com/Xcraft-Inc/xcraft-core-book
[xcraft-core-utils]: https://github.com/Xcraft-Inc/xcraft-core-utils
[xcraft-core-fs]: https://github.com/Xcraft-Inc/xcraft-core-fs
[xcraft-core-transport]: https://github.com/Xcraft-Inc/xcraft-core-transport
[xcraft-core-etc]: https://github.com/Xcraft-Inc/xcraft-core-etc
[xcraft-core-goblin]: https://github.com/Xcraft-Inc/xcraft-core-goblin
[xcraft-core-host]: https://github.com/Xcraft-Inc/xcraft-core-host
[xcraft-core-log]: https://github.com/Xcraft-Inc/xcraft-core-log
[xcraft-core-server]: https://github.com/Xcraft-Inc/xcraft-core-server

_Ce contenu a été généré par IA_
