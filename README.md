# 📘 xcraft-core-cryo

## Aperçu

Le module `xcraft-core-cryo` est une couche de persistance sophistiquée pour l'écosystème Xcraft, basée sur SQLite. Il implémente un système d'event sourcing qui permet de sauvegarder, récupérer et gérer l'historique des mutations d'état des acteurs Goblin et Elf. Ce module est fondamental pour la persistance des données dans les applications Xcraft, offrant des fonctionnalités avancées comme la recherche plein texte (FTS), la recherche vectorielle (VEC) avec migration automatique des dimensions, la synchronisation distribuée et le nettoyage automatique des données obsolètes.

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Configuration avancée](#configuration-avancée)
- [Détails des sources](#détails-des-sources)

## Structure du module

Le module `xcraft-core-cryo` est organisé autour de plusieurs composants clés :

- **`cryo.js`** (racine) : Point d'entrée qui expose les commandes Xcraft et initialise les endpoints configurés
- **`lib/cryo.js`** : Classe principale `Cryo` héritant de `SQLite`, implémentant toutes les fonctionnalités de persistance
- **`lib/index.js`** : Instance singleton de `Cryo` configurée via `xcraft-core-etc`
- **`lib/soulSweeper.js`** : Utilitaire de nettoyage et d'optimisation des bases de données
- **`lib/streamSQL.js`** : Classes `ReadableSQL` et `WritableSQL` pour le streaming de données SQLite
- **`lib/streamPort.js`** : Classes `MessagePortReadable` et `MessagePortWritable` pour le streaming inter-threads via MessageChannel, avec surveillance (watchdog) configurable
- **`lib/sqlite-vec/loader.js`** : Chargement de l'extension SQLite pour la recherche vectorielle
- **`lib/endpoints/googleQueue.js`** : Endpoint optionnel pour publier les actions dans Google Cloud Pub/Sub
- **`lib/workers/insert.js`** : Worker thread dédié au peuplement FTS/VEC et au traitement des embeddings
- **`lib/workers/retrieve.js`** : Worker thread dédié à la récupération streamée des actions persist

## Fonctionnement global

Cryo fonctionne selon le principe d'event sourcing :

1. **Persistance** : Les actions (événements) sont "gelées" (`freeze`) dans la base de données SQLite
2. **Reconstruction** : Chaque action contient les informations nécessaires pour reconstruire l'état d'un acteur
3. **Récupération** : Les actions peuvent être "dégelées" (`thaw`) pour reconstruire l'état à un moment précis
4. **Historique** : Le système maintient un historique complet des changements

### Structure des actions

Les actions sont stockées dans une table `actions` avec les colonnes suivantes :

- `rowid` : Clé primaire auto-incrémentée (avec index explicite pour les performances de comptage)
- `timestamp` : Horodatage de l'action au format ISO
- `goblin` : Identifiant de l'acteur concerné (ex : `myEntity-myEntity@1`)
- `action` : Contenu JSON de l'action
- `version` : Version de l'application au moment de la persistance
- `type` : Type d'action (`create`, `persist`, etc.)
- `commitId` : Identifiant de commit pour la synchronisation distribuée (NULL si non synchronisé)

### Fonctionnalités avancées

**Recherche plein texte (FTS5)** — Quand `enableFTS` est activé, une table `lastPersistedActions` maintient la dernière action persist par goblin (hors statut `trashed`). Une table virtuelle `fts_idx` indexe le champ `meta.index` de chaque état. Des triggers SQLite maintiennent automatiquement cet index et peuvent déclencher des notifications via des topics configurables.

**Recherche vectorielle (VEC)** — Quand `enableVEC` est activé (nécessite `enableFTS`), une table virtuelle `embeddings` (via `sqlite-vec`) stocke les embeddings de chaque document partitionnés par locale. Le traitement des embeddings est délégué à un worker thread Piscina pour éviter de bloquer le thread principal. Un index `embeddingsIndex` associe chaque document à la ligne de son action persist la plus récente.

À chaque ouverture d'une base avec VEC activé, Cryo inspecte le SQL de la table `embeddings` existante et en extrait le type et la dimension du vecteur (`embedding FLOAT[N]` ou `embedding int8[N]`) par une expression régulière. Si la dimension ou le type configuré (`vec.dimensions`, `vec.vecFunc`) diffère de celui déjà présent en base, la table `embeddings` est automatiquement supprimée puis recréée avec la nouvelle définition — une migration transparente lors d'un changement de modèle d'embeddings. Cryo enregistre également, pour les bases persistantes (non préfixées par un point), des triggers automatiques sur l'actorType `indexedContent` afin de déclencher le worker d'embedding (`<worker-vec-embed>`) à chaque insertion ou mise à jour.

**Transactions et verrous** — Les transactions sont gérées avec un mutex par base de données (`_syncLock`) pour garantir la cohérence des accès concurrents. Les notifications déclenchées par les triggers FTS sont mises en file d'attente pendant une transaction et envoyées après le `commit`.

**Middleware de transformation** — Un mécanisme de middleware chainé permet de transformer les lignes lors de la récupération (`thaw`). Un middleware peut diviser une action en plusieurs actions ou la supprimer. Cela est utile pour les migrations de modèles de données.

**Synchronisation distribuée** — Le système utilise des `commitId` (UUID) pour tracer l'état de synchronisation de chaque action. Le flux de synchronisation comprend : récupération des actions en attente (`getDataForSync`), marquage temporaire avec un commitId zéro (`prepareDataForSync`), puis mise à jour avec le commitId serveur définitif (`updateActionsAfterSync`).

**Bootstrap** — Pour initialiser une base de données depuis un flux distant, `bootstrapActions` crée une base temporaire préfixée par un point (`.db`), la peuple via un stream, puis la renomme. Les actions locales en attente de synchronisation sont préservées lors de ce processus.

**Nettoyage (SoulSweeper)** — Chaque base de données dispose d'un `SoulSweeper` dédié qui peut nettoyer les actions obsolètes selon deux stratégies : par nombre maximum de persists par goblin ou par date limite. La stratégie combinée `sweepForDays` applique les deux en séquence. Les commandes exposées `sweep` et `sweepByMaxCount` permettent de piloter ce nettoyage avec des paramètres personnalisables (nombre de jours et de persists à conserver).

**Table temporelle** — Optionnellement activée via `enableTimetable`, une table `timetable` précalculée de 64 000 jours (depuis l'an 2000) permet des analyses chronologiques avancées.

**Streaming inter-threads résilient** — Les flux de données entre le thread principal et les workers (via `MessageChannel`) sont surveillés par un watchdog dont le délai est configurable (`workers.streamPort.timeout`), ce qui permet de détecter un lecteur mort et de libérer les ressources associées.

### Flux de traitement des embeddings

```
Action persist insérée (goblin de type indexedContent)
    → Trigger SQL onInsert/onUpdate sur lastPersistedActions
    → Notification sur topic <worker-vec-embed>
    → Souscription resp.events → Piscina.run({name: 'embed'})
    → Worker thread: delete + insert dans embeddings + embeddingsIndex
```

## Exemples d'utilisation

### Vérification et initialisation d'une base de données

```javascript
// Dans une méthode d'un acteur Elf
async cryoStuff() {
  const cryo = this.quest.getAPI('cryo');

  const result = await cryo.isEmpty({ db: 'myDatabase' });
  console.log(result); // {exists: true, empty: false}

  // Ouvrir/initialiser explicitement une base
  const ok = await cryo.init({ db: 'myDatabase' });
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
                embedding: 'deadbeef...' // hexadécimal
              }
            }
          }
        }
      }
    },
    rules: {
      goblin: 'myEntity-myEntity@1',
      mode: 'last' // Conserver uniquement la dernière action
    }
  });
}
```

### Récupération des actions

```javascript
async thawSomething() {
  const cryo = this.quest.getAPI('cryo');

  // Les résultats arrivent via des événements 'cryo.thawed.myDatabase'
  const count = await cryo.thaw({
    db: 'myDatabase',
    timestamp: '2023-05-01T12:00:00.000Z'
  });
  console.log(`${count} actions récupérées`);

  // Récupération partielle par type
  const partial = await cryo.thaw({
    db: 'myDatabase',
    timestamp: '2023-05-01T12:00:00.000Z',
    type: 'myEntity',
    length: 100,
    offset: 0
  });
}
```

### Utilisation des transactions

```javascript
async withTransaction() {
  const cryo = this.quest.getAPI('cryo');

  await cryo.immediate({ db: 'myDatabase' });
  try {
    await cryo.freeze({
      db: 'myDatabase',
      action: { type: 'persist', payload: {/* ... */} },
      rules: { goblin: 'myEntity-myEntity@1', mode: 'last' }
    });
    await cryo.commit({ db: 'myDatabase' });
  } catch (error) {
    await cryo.rollback({ db: 'myDatabase' });
    throw error;
  }
}
```

### Bootstrap d'une base de données depuis un flux distant

```javascript
async bootstrapDatabase(streamId, routingKey, count) {
  const cryo = this.quest.getAPI('cryo');

  await cryo.bootstrapActions({
    db: 'myDatabase',
    streamId,
    routingKey,
    rename: true, // Renommer l'ancienne base avant remplacement
    count         // Nombre total d'actions pour la progression
  });
}
```

### Nettoyage des données obsolètes

```javascript
async cleanupDatabase() {
  const cryo = this.quest.getAPI('cryo');

  // Stratégie combinée : max 10 persists récents (défaut) + 1 persist si > 30 jours (défaut)
  const changes = await cryo.sweep({ dbs: ['myDatabase'] });
  console.log(changes); // { myDatabase: 1234 }

  // Personnaliser le nombre de jours et le nombre maximum de persists conservés
  await cryo.sweep({ dbs: ['myDatabase'], max: 5, days: 15 });

  // Ou garder seulement les 5 derniers persists par goblin (sans contrainte de date)
  await cryo.sweepByMaxCount({ dbs: ['myDatabase'], max: 5 });
}
```

### Synchronisation distribuée

```javascript
async syncData() {
  const cryo = this.quest.getAPI('cryo');

  const { stagedActions, commitIds } = await cryo.getDataForSync({ db: 'myDatabase' });

  // Marquer les actions avec le commitId zéro (en transit)
  await cryo.prepareDataForSync({
    db: 'myDatabase',
    rows: stagedActions.map(a => a.rowid),
    zero: true
  });

  // Après confirmation du serveur, appliquer le vrai commitId
  await cryo.updateActionsAfterSync({
    db: 'myDatabase',
    serverCommitId: 'abc123-def456-...',
    rows: stagedActions.map(a => a.rowid)
  });
}
```

### Récupération streamée de persists pour la synchronisation

```javascript
async syncPersists() {
  const cryo = this.quest.getAPI('cryo');

  // Récupérer tous les persists via stream
  const { xcraftStream, routingKey, count } = await cryo.getAllPersist({ db: 'myDatabase' });

  // Récupérer les persists dans une plage de commitIds
  const rangeResult = await cryo.getPersistFromRange({
    db: 'myDatabase',
    fromCommitId: 'uuid-from',
    toCommitId: 'uuid-to',
    toInclusive: true
  });
}
```

## Interactions avec d'autres modules

- **[xcraft-core-book]** : Fournit la classe `SQLite` dont `Cryo` hérite ; gère l'ouverture, les requêtes préparées et les migrations
- **[xcraft-core-utils]** : Utilisé pour les mutex (`locks.getMutex`) et utilitaires JS
- **[xcraft-core-fs]** : Gestion des fichiers et répertoires (copie, suppression de bases SQLite)
- **[xcraft-core-transport]** : Streaming des données via `Streamer` lors du bootstrap
- **[xcraft-core-etc]** : Chargement de la configuration du module (y compris le délai du watchdog de `streamPort`)
- **[xcraft-core-goblin]** : Les acteurs Goblin et Elf utilisent Cryo pour persister leur état via les commandes exposées sur le bus
- **[xcraft-core-host]** : Fournit `appVersion`, `resourcesPath` et `getRoutingKey()`
- **[xcraft-core-log]** : Utilisé par `SoulSweeper` pour journaliser les opérations de nettoyage
- **@google-cloud/pubsub** : Dépendance optionnelle (peer) utilisée par l'endpoint `googleQueue`

## Configuration avancée

| Option                       | Description                                                                                                                    | Type    | Valeur par défaut |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------- |
| `journal`                    | Mode journal SQLite (`journal` ou `WAL`)                                                                                       | String  | `"WAL"`           |
| `endpoints`                  | Liste des endpoints à activer                                                                                                  | Array   | `[]`              |
| `enableFTS`                  | Activer la recherche plein texte (FTS5)                                                                                        | Boolean | `false`           |
| `enableVEC`                  | Activer la recherche vectorielle (nécessite `enableFTS`)                                                                       | Boolean | `false`           |
| `fts.list`                   | Bases de données où activer FTS (toutes si vide)                                                                               | Array   | `[]`              |
| `vec.list`                   | Bases de données où activer VEC (toutes si vide)                                                                               | Array   | `[]`              |
| `vec.dimensions`             | Nombre de dimensions pour les embeddings (une modification déclenche une recréation automatique de la table `embeddings`)      | Number  | `4096`            |
| `vec.vecFunc`                | Fonction de conversion vectorielle (`vec_f32` ou `vec_int8`)                                                                   | String  | `"vec_f32"`       |
| `vec.defaultLocale`          | Locale par défaut pour le partitionnement des vecteurs                                                                         | String  | `"fr"`            |
| `migrations.cleanings`       | Règles de nettoyage par nom de base (types de goblins à supprimer)                                                             | Object  | `null`            |
| `enableTimetable`            | Activer la table de temps précalculée                                                                                          | Boolean | `false`           |
| `workers.streamPort.timeout` | Délai (ms) du watchdog de backpressure avant destruction d'un stream de type `MessagePortWritable` faute de demande du lecteur | Number  | `120000`          |
| `googleQueue.topic`          | Topic Google Pub/Sub pour publier les messages                                                                                 | String  | `""`              |
| `googleQueue.authFile`       | Chemin relatif vers le fichier d'authentification Google Cloud                                                                 | String  | `""`              |
| `googleQueue.orderingPrefix` | Partie fixe de la clé d'ordonnancement des messages                                                                            | String  | `""`              |

### Variables d'environnement

| Variable                         | Description                                                                                                               | Exemple                               | Valeur par défaut |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------- |
| `GOOGLE_APPLICATION_CREDENTIALS` | Chemin vers le fichier d'authentification Google Cloud ; défini automatiquement par l'endpoint `googleQueue` au démarrage | `/app/resources/gcp-credentials.json` | —                 |

## Détails des sources

### `cryo.js` — Point d'entrée et exposition des commandes

Ce fichier agit comme façade entre le bus Xcraft et la classe `Cryo`. Au démarrage, il charge dynamiquement les endpoints activés dans la configuration (`cryoConfig.endpoints`), puis expose automatiquement toutes les méthodes publiques de l'instance `Cryo` comme commandes parallèles sur le bus via `xcraftCommands`.

Pour chaque commande, le fichier gère le cycle complet : appel de la méthode Cryo, propagation aux endpoints actifs (si la méthode existe sur l'endpoint), puis envoi de l'événement `cryo.<n>.<msgId>.finished` avec le résultat ou `cryo.<n>.<msgId>.error` en cas d'exception. Un traitement spécial est appliqué à `freeze` : seul `{action}` est retourné pour les actions de type `persist` (les autres résultats sont ignorés).

La méthode `dispose` exportée ferme proprement l'instance Cryo (workers Piscina, souscriptions d'embeddings, optimisation SQLite).

### `lib/cryo.js` — Classe principale `Cryo`

La classe `Cryo` hérite de `SQLite` ([xcraft-core-book]) et constitue le cœur du module.

#### Initialisation

Le constructeur détermine le répertoire de stockage (`xcraft.xcraftRoot/var/cryo` par défaut), charge la configuration et prépare toutes les requêtes SQL préparées. Selon la configuration, il génère les DDL pour les tables optionnelles (`timetable`, `lastPersistedActions`, `fts_idx`, `embeddings`, `embeddingsIndex`) et leurs triggers associés. Les indices sont créés sur `goblin`, `timestamp`, `type`, `commitId` et `rowid` (index couvrant explicite pour optimiser les requêtes de comptage).

La version de schéma (`PRAGMA user_version`) est gérée via un mécanisme de migration incrémentale jusqu'à la version 12. À chaque ouverture, si VEC est activé, Cryo compare également la dimension et le type de vecteur configurés à ceux réellement présents dans le schéma SQL de la table `embeddings` : en cas de divergence, la table est supprimée et recréée avec la nouvelle définition (migration automatique de dimension d'embedding).

#### Workers Piscina

Deux pools de workers sont gérés :

- **`#piscina[db]`** : Un pool par base de données, avec un seul thread (`minThreads: 1, maxThreads: 1`), utilisé pour `embed` et `populate`. Il se ferme automatiquement après 1 seconde d'inactivité.
- **`#piscinaSync`** : Pool partagé pour les opérations de récupération streamée (`getAllPersist`, `getPersistFromRange`), avec 0 à N threads et 30 secondes de timeout d'inactivité.

#### Méthodes publiques

- **`freeze(resp, msg)`** — Persiste une action. Supporte les modes `all` (conservation de tout l'historique) et `last` (suppression des anciennes actions d'un goblin). Avant insertion, vérifie si la dernière action persist est identique pour éviter les doublons (via comparaison du champ `state`). Si identique, les actions intermédiaires inutiles sont annulées (`revert`). Les actions `raw` (provenant d'un serveur de sync) sont ignorées si une transaction Cryo est ouverte pour ce goblin.

- **`thaw(resp, msg)`** — Récupère la dernière action par goblin jusqu'à un timestamp. Supporte la pagination via `type`, `length` et `offset`. Applique la chaîne de middlewares sur chaque ligne. Les résultats sont envoyés par événements `cryo.thawed.<db>`, groupés par action source (une action source peut produire 0 à N lignes après middleware).

- **`frozen(resp, msg)`** — Retourne le nombre d'actions et le timestamp de la dernière action, avec filtrage optionnel par type.

- **`isEmpty(resp, msg)`** — Retourne `{exists, empty}` selon l'existence et le contenu de la base.

- **`init(resp, msg)`** — Ouvre une base de données et déclenche le rafraîchissement des embeddings en arrière-plan si VEC est activé.

- **`immediate(resp, msg)`** / **`exclusive(resp, msg)`** / **`begin(resp, msg)`** — Démarrent une transaction avec acquisition du mutex associé à la base.

- **`commit(resp, msg)`** — Valide la transaction et envoie les notifications trigger FTS en attente, puis libère le mutex.

- **`rollback(resp, msg)`** — Annule la transaction et libère le mutex.

- **`restore(resp, msg)`** — Restaure une base à un timestamp en copiant la source vers la destination, puis en supprimant les actions postérieures au timestamp. Si source et destination sont identiques, l'original est d'abord archivé sous un nom horodaté (branche).

- **`branch(resp, msg)`** — Archive la base actuelle en la renommant avec un timestamp (via `fs-extra.rename`).

- **`dump(resp, msg)`** — Exporte les dernières actions par goblin jusqu'à un timestamp vers une base de données distincte via `ATTACH DATABASE`.

- **`registerLastActionTriggers(resp, msg)`** — Enregistre des topics d'événements déclenchés par les triggers FTS lors des insertions, mises à jour ou suppressions dans `lastPersistedActions`. Nécessite `enableFTS`. Utilisé en interne pour l'actorType `indexedContent` lorsque VEC est activé.

- **`unregisterLastActionTriggers(resp, msg)`** — Retire des topics précédemment enregistrés.

- **`actions(resp, msg)`** — Itère sur les actions dans une plage de timestamps et envoie chaque ligne via `cryo.actions.<db>`.

- **`getEntityTypeCount(resp, msg)`** — Retourne un tableau d'objets `{type, count}` en extrayant le préfixe de type de chaque goblin.

- **`branches(resp)`** — Liste les fichiers `.db` du répertoire Cryo et détecte les branches (fichiers `<n>_<timestamp>.db`). Retourne `{[db]: {branches: [timestamp, ...]}}`.

- **`isAlreadyCreated(resp, msg)`** — Détermine si un goblin a déjà été créé : retourne `true` s'il a au moins un `persist`, ou s'il a plus d'une action `create` (la deuxième `create` signifie que le goblin avait déjà existé).

- **`hasGoblin(resp, msg)`** — Vérifie la présence d'au moins une action pour un goblin donné.

- **`loadMiddleware(resp, msg)`** — Charge dynamiquement un fichier middleware et l'ajoute à la chaîne de transformation. Le middleware est caché via `require.cache` pour éviter les rechargements.

- **`getDataForSync(resp, msg)`** — Retourne les actions en attente (`allStagedActions` : actions non-persist sans commitId situées avant le dernier persist sans commitId) ainsi qu'une sélection de commitIds récents (dernier, 10ème, 100ème, 200ème, 1000ème) pour la négociation de synchronisation.

- **`prepareDataForSync(resp, msg)`** — Marque les lignes spécifiées avec le commitId zéro (`00000000-0000-0000-0000-000000000000`) pour indiquer qu'elles sont en cours de synchronisation.

- **`updateActionsAfterSync(resp, msg)`** — Remplace le commitId zéro par le commitId serveur définitif sur les lignes confirmées.

- **`countPersistsFrom(resp, msg)`** / **`countNewPersistsFrom(resp, msg)`** — Comptent les actions persist (total ou depuis un commitId donné).

- **`hasCommitId(resp, msg)`** / **`getLastCommitId(resp, msg)`** / **`getSomeCommitIds(resp, msg)`** — Requêtes utilitaires pour la négociation de synchronisation.

- **`getPersistFromRange(resp, msg)`** — Récupère les derniers persists par goblin dans une plage de commitIds, via un worker Piscina et un `MessageChannel`. Retourne un `xcraftStream` consommable par le transport Xcraft.

- **`getAllPersist(resp, msg)`** — Récupère tous les derniers persists par goblin via streaming. Retourne `{xcraftStream, routingKey, count}`.

- **`bootstrapActions(resp, msg, next)`** — Générateur watt. Crée une base temporaire `.db`, la peuple depuis un flux de données (via `WritableSQL` et `Streamer`), réinjecte les actions locales en attente, peuple FTS/VEC via worker, puis remplace la base principale. En cas d'erreur, nettoie la base temporaire.

- **`getZeroActions(resp, msg)`** — Retourne les actions non-persist marquées avec le commitId zéro.

- **`getActionsByIds(resp, msg)`** — Retourne le dernier persist par goblin pour une liste d'identifiants.

- **`hasActions(resp, msg)`** — Vérifie que tous les goblins spécifiés ont au moins un persist.

- **`sweep(resp, msg)`** — Lance `sweepForDays(days, max)` sur les bases spécifiées (ou toutes, via `getAllNames()` si `dbs` n'est pas fourni). Les paramètres `max` (défaut `10`) et `days` (défaut `30`) sont configurables via `msg.data`. Retourne un objet `{[db]: changes}`.

- **`sweepByMaxCount(resp, msg)`** — Lance `sweepByCount(max)` sur les bases spécifiées (ou toutes).

- **`refreshEmbeddings(resp, msg)`** — Retraite les embeddings obsolètes sur les bases VEC activées via le worker `refreshEmbeddings`.

- **`usable()`** — Délègue à `SQLite.usable()`.

- **`getLocation()`** — Retourne le chemin du répertoire de stockage Cryo.

- **`dispose()`** — Ferme les pools Piscina, désabonne les listeners d'embeddings, optimise toutes les bases (`PRAGMA optimize`) et appelle `super.dispose()`.

### `lib/soulSweeper.js` — Nettoyage intelligent des actions

`SoulSweeper` encapsule la logique de nettoyage des actions SQLite avec des requêtes CTE optimisées. Il est instancié une fois par base de données ouverte.

Le paramètre `withCommits` (défaut `true`) contrôle si le nettoyage se limite aux actions ayant un `commitId` non-null, ce qui est important pour ne pas supprimer des données non synchronisées.

#### Méthodes publiques

- **`sweepByCount(count=4, dryrun=true)`** — Garde les `count` derniers persists par goblin (entre 1 et 100), supprime tous ceux en dessous du seuil ainsi que leurs actions intermédiaires. Lance un `ANALYZE` avant et un `VACUUM` si plus de 100 000 lignes sont supprimées. Lève une erreur si `count` est en dehors de la plage `[1, 100]`.

- **`sweepByDatetime(datetime=now, dryrun=true)`** — Supprime les actions dont le timestamp est antérieur à `datetime`, en gardant au minimum les 2 derniers persists par goblin.

- **`sweepForDays(days=30, max=10, dryrun=true)`** — Stratégie combinée : d'abord `sweepByCount(max)` pour limiter le nombre total, puis `sweepByDatetime(now - days)` pour éliminer les anciennes données. Retourne le cumul des suppressions.

Le mode `dryrun=true` (défaut) calcule le nombre de lignes qui seraient supprimées sans les effacer, permettant une prévisualisation.

### `lib/streamSQL.js` — Streaming SQL

**`ReadableSQL`** — Stream Node.js lisible alimenté par un itérateur SQLite. Lit les lignes par lots de 128 et les sérialise en JSON. Supporte une fonction `wait` pour les opérations SQLite asynchrones.

**`WritableSQL`** — Stream Node.js inscriptible pour l'insertion en masse. Démarre automatiquement une transaction à la construction, effectue des commits intermédiaires tous les `step` lots (défaut 1024), et accepte un callback de progression `progressCb(pos)`.

### `lib/streamPort.js` — Streaming via MessageChannel

**`MessagePortWritable`** — Stream inscriptible qui envoie les chunks via un `MessagePort`. Implémente un protocole de back-pressure : le lecteur envoie un message vide pour signaler sa demande, et le writer attend cette demande avant d'envoyer. Tente le transfert zero-copy (`Transferable`) et bascule en copie en cas d'échec. Un watchdog détecte les lecteurs morts après un délai d'inactivité configurable via l'option `workers.streamPort.timeout` (chargée depuis la configuration `xcraft-core-cryo`, défaut `120000` ms), et détruit alors le stream avec une `WriterTimeoutError`.

**`MessagePortReadable`** — Stream lisible qui reçoit les chunks depuis un `MessagePort` et les pousse dans le flux Node.js. Envoie une demande initiale au writer, puis une nouvelle demande à chaque `_read()`. Gère la terminaison propre du port.

### `lib/index.js` — Instance singleton

Exporte l'unique instance de `Cryo` utilisée par tous les handlers de commandes, configurée avec les paramètres chargés via `xcraft-core-etc`.

### `lib/endpoints/googleQueue.js` — Publication Google Cloud Pub/Sub

Endpoint optionnel activé en ajoutant `"googleQueue"` à la liste `endpoints` de la configuration. Il intercepte les résultats de la commande `freeze` et les publie dans un topic Google Pub/Sub avec ordonnancement des messages.

#### Méthodes publiques

- **`freeze(resp, msg, results)`** — Publie l'action dans Pub/Sub avec les attributs `origin`, `publish_timestamp`, `timestamp`, `goblin` et `version`. Utilise la clé d'ordonnancement configurée et active `enableMessageOrdering` sur le topic.

### `lib/sqlite-vec/loader.js` — Extension vectorielle SQLite

Module utilitaire qui charge l'extension native `sqlite-vec` (`vec0`) dans une instance de base de données SQLite. Supporte les plateformes Linux, macOS et Windows en architecture x86_64 et aarch64. Gère le chemin `app.asar.unpacked` pour les applications Electron packagées.

#### Méthodes publiques

- **`load(db)`** — Charge l'extension dans l'instance SQLite fournie via `db.loadExtension(path)`.
- **`getLoadablePath()`** — Résout le chemin de la bibliothèque native selon la plateforme et l'architecture courantes.

### `lib/workers/insert.js` — Worker FTS/VEC

Worker thread Piscina exposant trois tâches :

**`populate({db, location, enableFTS, enableVEC, defaultLocale, indices, vecFunc})`** — Exécuté après un bootstrap ou une migration. Peuple `fts_idx` depuis `lastPersistedActions` si FTS est activé, et peuple `embeddings` + `embeddingsIndex` depuis les dernières actions persist si VEC est activé. Applique ensuite les indices personnalisés et exécute `ANALYZE`.

**`embed({db, location, goblin, defaultLocale, vecFunc})`** — Exécuté à chaque modification d'une entité `indexedContent` (déclenchée par les triggers FTS). Supprime les embeddings existants pour le `documentId` et les réinsère depuis la dernière action persist du goblin. Opère dans une transaction `IMMEDIATE`.

**`refreshEmbeddings({db, location, defaultLocale, vecFunc})`** — Détecte les embeddings obsolètes (ceux dont le `documentRowid` dans `embeddingsIndex` ne correspond plus au `max(rowid)` de l'action persist courante), les supprime et les réinsère. Utile après une synchronisation ou un import de données.

La table `embeddings` utilise la structure suivante :

```sql
CREATE VIRTUAL TABLE embeddings USING vec0(
  locale TEXT partition key,
  scope TEXT,
  documentId TEXT,
  +chunkId TEXT,
  +chunk TEXT,
  embedding FLOAT[dimensions] distance_metric=cosine
);
```

Le partitionnement par `locale` permet des recherches vectorielles ciblées par langue. La métrique de distance cosinus est utilisée pour la similarité sémantique.

### `lib/workers/retrieve.js` — Worker de récupération streamée

Worker thread Piscina exposant deux tâches pour la récupération en lecture seule des actions persist via `MessagePortWritable` et `ReadableSQL` :

**`getAllPersist({port, location, db})`** — Récupère le dernier persist par goblin (ayant un commitId non-null) trié par rowid, et l'envoie ligne par ligne via le port.

**`getPersistFromRange({port, location, db, fromCommitId, toCommitId, toInclusive})`** — Récupère les derniers persists dans une plage de commitIds via des CTE SQL. Si `fromCommitId` est absent, récupère tous les persists jusqu'à `toCommitId`. Si `toInclusive` est vrai, inclut les actions du `toCommitId` dans le résultat.

### Fichiers de tests

**`test/soulSweeper.spec.js`** — Suite de tests pour `SoulSweeper` avec Mocha/Chai, organisée en deux blocs :

- Un bloc d'intégration (`describe.skip`, désactivé par défaut) qui valide `sweepByCount`, `sweepByDatetime` et une stratégie combinée sur une base réelle `cms.db` (nécessite une extraction manuelle du fichier compressé).
- Un bloc de tests unitaires (toujours actif) sur une base SQLite en mémoire, couvrant : la conservation des `count` derniers persists par goblin, la préservation des actions intermédiaires entre persists conservés, le comportement de l'option `withCommits` (permettant ou non de nettoyer les persists sans `commitId`), la validation des bornes de `count` (erreurs en dehors de `[1, 100]`), le cas d'une base vide, et le cas d'un goblin ayant moins de persists que le seuil demandé.

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

_Ce contenu a été généré par IA_
