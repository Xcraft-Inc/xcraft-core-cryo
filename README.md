# 📘 Documentation du module xcraft-core-cryo

## Aperçu

Le module `xcraft-core-cryo` est une couche de persistance sophistiquée pour l'écosystème Xcraft, basée sur SQLite. Il implémente un système d'event sourcing qui permet de sauvegarder, récupérer et gérer l'historique des mutations d'état des acteurs Goblin et Elf. Ce module est fondamental pour la persistance des données dans les applications Xcraft, offrant des fonctionnalités avancées comme la recherche plein texte (FTS), la recherche vectorielle (VEC), et la synchronisation distribuée.

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Configuration avancée](#configuration-avancée)
- [Détails des sources](#détails-des-sources)

## Structure du module

Le module `xcraft-core-cryo` est organisé autour de plusieurs composants clés :

- **Cryo** : Classe principale qui encapsule les fonctionnalités de persistance et de récupération
- **SoulSweeper** : Utilitaire pour nettoyer les anciennes actions et optimiser la base de données
- **StreamSQL** : Classes pour la lecture/écriture de flux de données SQL
- **Endpoints** : Extensions pour connecter Cryo à d'autres systèmes (comme Google Queue)
- **SQLite-Vec** : Support pour la recherche vectorielle via une extension SQLite

Le module expose une API complète via `xcraftCommands` pour la gestion des actions, avec des fonctionnalités de :

- Persistance (`freeze`)
- Récupération (`thaw`)
- Synchronisation et transactions
- Recherche plein texte (FTS) et vectorielle (VEC)
- Nettoyage et optimisation des données

## Fonctionnement global

Cryo fonctionne selon le principe d'event sourcing :

1. **Persistance** : Les actions (événements) sont "gelées" (`freeze`) dans la base de données SQLite
2. **Reconstruction** : Chaque action contient les informations nécessaires pour reconstruire l'état d'un acteur
3. **Récupération** : Les actions peuvent être "dégelées" (`thaw`) pour reconstruire l'état à un moment précis
4. **Historique** : Le système maintient un historique complet des changements

### Structure des actions

Les actions sont stockées avec des métadonnées complètes :

- `timestamp` : Horodatage de l'action
- `goblin` : Identifiant de l'acteur concerné
- `action` : Contenu JSON de l'action
- `version` : Version de l'application
- `type` : Type d'action (create, persist, etc.)
- `commitId` : Identifiant de commit pour la synchronisation

### Fonctionnalités avancées

Le module offre des fonctionnalités sophistiquées :

- **Recherche plein texte** via SQLite FTS5 avec indexation automatique
- **Recherche vectorielle** pour les embeddings (avec dimensions configurables)
- **Synchronisation** des actions entre différentes instances
- **Nettoyage automatique** des anciennes actions via SoulSweeper
- **Transactions et verrous** pour garantir la cohérence des données
- **Worker threads** pour le traitement des embeddings en arrière-plan
- **Endpoints configurables** pour l'intégration avec des systèmes externes
- **Middleware** pour la transformation des données lors de la récupération
- **Table temporelle** pour les analyses chronologiques avancées

## Exemples d'utilisation

### Initialisation et vérification d'une base de données

```javascript
// Dans une méthode d'un acteur Elf
async cryoStuff() {
  const cryo = this.quest.getAPI('cryo');

  // Vérifier si une base de données existe et est vide
  const result = await cryo.isEmpty({
    db: 'myDatabase'
  });
  console.log(result); // {exists: true, empty: false}
}
```

### Persistance d'une action

```javascript
// Dans une méthode d'un acteur Elf
async freezeSomething() {
  const cryo = this.quest.getAPI('cryo');

  // Geler une action dans la base de données
  await cryo.freeze({
    db: 'myDatabase',
    action: {
      type: 'persist',
      payload: {
        state: {
          id: 'myEntity@1',
          // ... autres propriétés d'état
          meta: {
            status: 'published',
            index: 'contenu indexable pour FTS',
            vectors: {
              chunk1: {
                chunk: 'Premier morceau de texte',
                embedding: 'deadbeef...' // embedding hexadécimal
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
// Dans une méthode d'un acteur Elf
async thawSomething() {
  const cryo = this.quest.getAPI('cryo');

  // Récupérer toutes les actions jusqu'à un timestamp donné
  const count = await cryo.thaw({
    db: 'myDatabase',
    timestamp: '2023-05-01T12:00:00.000Z'
  });

  // Les résultats sont envoyés via des événements
  // resp.events.send('cryo.thawed.myDatabase', rows);
  console.log(`${count} actions récupérées`);
}
```

### Utilisation des transactions

```javascript
// Dans une méthode d'un acteur Elf
async withTransaction() {
  const cryo = this.quest.getAPI('cryo');

  // Démarrer une transaction immédiate
  await cryo.immediate({
    db: 'myDatabase'
  });

  try {
    // Effectuer des opérations dans la transaction
    await cryo.freeze({
      db: 'myDatabase',
      action: {
        type: 'persist',
        payload: {/* ... */}
      },
      rules: {
        goblin: 'myEntity-myEntity@1',
        mode: 'last'
      }
    });

    // Valider la transaction
    await cryo.commit({
      db: 'myDatabase'
    });
  } catch (error) {
    // Annuler la transaction en cas d'erreur
    await cryo.rollback({
      db: 'myDatabase'
    });
    throw error;
  }
}
```

### Nettoyage des anciennes actions

```javascript
// Dans une méthode d'un acteur Elf
async cleanupDatabase() {
  const cryo = this.quest.getAPI('cryo');

  // Nettoyer les actions plus anciennes que 30 jours, en gardant 10 actions par acteur
  const changes = await cryo.sweep({
    dbs: ['myDatabase']
  });
  console.log(changes); // Nombre d'actions supprimées par base de données

  // Ou nettoyer en gardant seulement 5 actions persist par goblin
  await cryo.sweepByMaxCount({
    dbs: ['myDatabase'],
    max: 5
  });
}
```

### Gestion des branches

```javascript
// Dans une méthode d'un acteur Elf
async manageBranches() {
  const cryo = this.quest.getAPI('cryo');

  // Créer une nouvelle branche
  await cryo.branch({
    db: 'myDatabase'
  });

  // Lister toutes les branches disponibles
  const branches = await cryo.branches();
  console.log(branches);
  // {
  //   myDatabase: {
  //     branches: ['20231201120000', '20231202150000']
  //   }
  // }
}
```

### Synchronisation des données

```javascript
// Dans une méthode d'un acteur Elf
async syncData() {
  const cryo = this.quest.getAPI('cryo');

  // Obtenir les données pour synchronisation
  const syncData = await cryo.getDataForSync({
    db: 'myDatabase'
  });

  // Préparer les actions pour synchronisation avec un commitId zéro
  await cryo.prepareDataForSync({
    db: 'myDatabase',
    rows: syncData.stagedActions.map(action => action.rowid),
    zero: true
  });

  // Après synchronisation avec le serveur, mettre à jour avec le vrai commitId
  await cryo.updateActionsAfterSync({
    db: 'myDatabase',
    serverCommitId: 'abc123-def456-...',
    rows: syncData.stagedActions.map(action => action.rowid)
  });
}
```

### Enregistrement de triggers pour notifications

```javascript
// Dans une méthode d'un acteur Elf
async setupTriggers() {
  const cryo = this.quest.getAPI('cryo');

  // Enregistrer des triggers pour être notifié des changements
  await cryo.registerLastActionTriggers({
    actorType: 'document',
    onInsertTopic: 'document.created',
    onUpdateTopic: 'document.updated',
    onDeleteTopic: 'document.deleted'
  });
}
```

## Interactions avec d'autres modules

- **[xcraft-core-book]** : Fournit la classe SQLite utilisée par Cryo
- **[xcraft-core-utils]** : Utilisé pour les verrous et autres utilitaires
- **[xcraft-core-fs]** : Gestion des fichiers et répertoires
- **[xcraft-core-transport]** : Streaming des données
- **[xcraft-core-etc]** : Configuration du module
- **[xcraft-core-goblin]** : Les acteurs Goblin utilisent Cryo pour persister leur état
- **[xcraft-core-host]** : Informations sur l'environnement d'exécution
- **@google-cloud/pubsub** : Utilisé par l'endpoint GoogleQueue pour la publication de messages

## Configuration avancée

Le module utilise un fichier `config.js` qui définit les options configurables via `xcraft-core-etc` :

| Option                       | Description                                            | Type    | Valeur par défaut |
| ---------------------------- | ------------------------------------------------------ | ------- | ----------------- |
| `journal`                    | Mode journal pour SQLite (journal ou WAL)              | String  | "WAL"             |
| `endpoints`                  | Liste des endpoints à activer                          | Array   | []                |
| `enableFTS`                  | Activer la recherche plein texte                       | Boolean | false             |
| `enableVEC`                  | Activer la recherche vectorielle (nécessite enableFTS) | Boolean | false             |
| `fts.list`                   | Liste des bases de données où utiliser FTS             | Array   | []                |
| `vec.list`                   | Liste des bases de données où utiliser VEC             | Array   | []                |
| `vec.dimensions`             | Nombre de dimensions pour les embeddings               | Number  | 4096              |
| `vec.defaultLocale`          | Locale par défaut pour le partitionnement              | String  | "fr"              |
| `migrations.cleanings`       | Règles de nettoyage par nom de base de données         | Object  | null              |
| `enableTimetable`            | Activer la table de temps                              | Boolean | false             |
| `googleQueue.topic`          | Topic pour publier les messages                        | String  | ""                |
| `googleQueue.authFile`       | Fichier d'authentification pour Google Queue           | String  | ""                |
| `googleQueue.orderingPrefix` | Partie fixe de la clé d'ordonnancement                 | String  | ""                |

### Variables d'environnement

| Variable                         | Description                                                                                                | Exemple                     | Valeur par défaut |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------- |
| `GOOGLE_APPLICATION_CREDENTIALS` | Chemin vers le fichier d'authentification Google Cloud (défini automatiquement par l'endpoint GoogleQueue) | `/path/to/credentials.json` | -                 |

## Détails des sources

### `cryo.js` - Point d'entrée principal

Ce fichier expose les commandes Xcraft et configure les endpoints. Il agit comme une façade pour la classe Cryo principale, gérant l'initialisation des endpoints configurés et l'exposition des méthodes via le système de commandes Xcraft.

**Fonctionnalités principales :**

- Chargement dynamique des endpoints selon la configuration
- Exposition automatique des méthodes de la classe Cryo comme commandes
- Gestion des événements de fin d'opération et d'erreur
- Traitement spécial pour la commande `freeze` (filtrage des résultats)
- Gestion du cycle de vie avec méthode `dispose`

### `lib/cryo.js` - Classe principale

La classe `Cryo` hérite de `SQLite` et implémente toutes les fonctionnalités de persistance :

#### État et modèle de données

La classe maintient plusieurs structures de données internes :

- `#soulSweeper` : Map des instances SoulSweeper par base de données
- `#worker` : Map des worker threads pour les embeddings vectoriels
- `#workerUnsub` : Map des fonctions de désinscription pour les workers
- `#userIndices` : Indices personnalisés par base de données
- `#boostrapping` : Flag indiquant si un bootstrap est en cours
- `_middleware` : Fonction middleware pour transformer les données
- `_lastActionTriggers` : Configuration des triggers pour les notifications
- `_triggerNotifs` : Notifications en attente par base de données

#### Méthodes publiques

**`freeze(resp, msg)`** - Persiste une action dans la base de données avec gestion des règles de rétention et des types d'actions. Supporte les modes 'all' et 'last' pour l'historique. Gère la synchronisation avec les actions brutes provenant du serveur et évite les doublons lors des transactions ouvertes.

**`thaw(resp, msg)`** - Récupère les actions jusqu'à un timestamp donné avec support de pagination et filtrage par type. Envoie les résultats via des événements et applique les middlewares de transformation. Supporte la récupération partielle avec offset et limite.

**`frozen(resp, msg)`** - Retourne des statistiques sur le nombre d'actions gelées, avec support du filtrage par type d'acteur.

**`isEmpty(resp, msg)`** - Vérifie si une base de données existe et est vide, retournant un objet avec les propriétés `exists` et `empty`.

**`immediate(resp, msg)`** - Démarre une transaction immédiate avec acquisition de verrous pour éviter les conflits d'accès concurrent.

**`exclusive(resp, msg)`** - Démarre une transaction exclusive avec verrouillage complet de la base de données pour les opérations critiques.

**`commit(resp, msg)`** - Valide une transaction et envoie toutes les notifications en attente provenant des triggers FTS.

**`rollback(resp, msg)`** - Annule une transaction en cours et libère les verrous associés.

**`branch(resp, msg)`** - Crée une nouvelle branche en renommant la base de données actuelle avec un timestamp.

**`restore(resp, msg)`** - Restaure une base de données à un point dans le temps spécifique en copiant et tronquant les données.

**`registerLastActionTriggers(resp, msg)`** - Enregistre des topics d'événements à déclencher lors des modifications de la table `lastPersistedActions`. Nécessite que FTS soit activé.

**`unregisterLastActionTriggers(resp, msg)`** - Désenregistre des topics d'événements précédemment configurés pour les triggers.

**`sweep(resp, msg)`** - Lance le nettoyage automatique des anciennes actions selon une stratégie par défaut (30 jours, max 10 actions).

**`sweepByMaxCount(resp, msg)`** - Nettoie les actions en gardant un nombre maximum spécifique d'actions persist par goblin (entre 1 et 10).

**`getDataForSync(resp, msg)`** - Récupère les actions en attente de synchronisation et les derniers commitIds pour la synchronisation avec un serveur distant.

**`prepareDataForSync(resp, msg)`** - Marque les actions avec un commitId temporaire (zéro) en préparation de la synchronisation.

**`updateActionsAfterSync(resp, msg)`** - Met à jour les actions avec le commitId définitif reçu du serveur après synchronisation réussie.

**`hasCommitId(resp, msg)`** - Vérifie si un commitId spécifique existe dans la base de données.

**`getLastCommitId(resp, msg)`** - Récupère le dernier commitId enregistré dans la base de données.

**`getSomeCommitIds(resp, msg)`** - Récupère une sélection de commitIds (le dernier, le 10ème, le 100ème, le 200ème, le 1000ème) pour l'optimisation de la synchronisation.

**`getPersistFromRange(resp, msg)`** - Récupère les actions persist dans une plage de commitIds avec support du streaming pour les gros volumes et option d'inclusion du commitId de fin.

**`getAllPersist(resp, msg)`** - Récupère toutes les actions persist via un stream pour traitement en lots avec routage automatique.

**`bootstrapActions(resp, msg)`** - Initialise une base de données avec un flux d'actions provenant d'un autre système, avec gestion des actions en attente et création d'une base temporaire préfixée par un point. Supporte le renommage de l'ancienne base.

**`getZeroActions(resp, msg)`** - Récupère les actions marquées avec le commitId zéro (en attente de synchronisation).

**`getActionsByIds(resp, msg)`** - Récupère les dernières actions persist pour une liste d'identifiants de goblins.

**`hasActions(resp, msg)`** - Vérifie si tous les goblins spécifiés ont des actions persist dans la base de données.

**`isAlreadyCreated(resp, msg)`** - Détermine si un goblin a déjà été créé en analysant ses actions create et persist.

**`hasGoblin(resp, msg)`** - Vérifie l'existence d'un goblin dans la base de données.

**`loadMiddleware(resp, msg)`** - Charge dynamiquement un middleware depuis un chemin spécifié pour transformer les données lors de la récupération.

**`getEntityTypeCount(resp, msg)`** - Retourne les types d'entités et leur nombre d'occurrences dans la base de données.

**`actions(resp, msg)`** - Extrait une liste d'actions selon une plage de timestamps et envoie les résultats via des événements.

**`dump(resp, msg)`** - Exporte les actions vers une nouvelle base de données jusqu'à un timestamp donné.

**`branches(resp, msg)`** - Liste toutes les bases de données et leurs branches disponibles dans le répertoire Cryo.

**`usable()`** - Vérifie si Cryo est utilisable (disponibilité de SQLite).

**`timestamp()`** - Génère un timestamp Cryo au format ISO.

**`getLocation()`** - Retourne le répertoire de stockage des bases de données Cryo.

**`sync(resp)`** - Méthode de synchronisation (actuellement vide, pour compatibilité).

**`close(db)`** - Ferme une base de données spécifique.

**`dispose()`** - Nettoie toutes les ressources, ferme les workers et optimise les bases de données avant fermeture.

### `lib/soulSweeper.js` - Nettoyage des données

Utilitaire spécialisé pour l'optimisation des bases de données avec plusieurs stratégies de nettoyage :

#### Méthodes publiques

**`sweepByCount(count, dryrun)`** - Garde un nombre spécifique d'actions persist par goblin (entre 1 et 100). Utilise des requêtes SQL optimisées avec CTE pour identifier les actions à supprimer tout en préservant les actions intermédiaires.

**`sweepByDatetime(datetime, dryrun)`** - Supprime les actions antérieures à une date donnée tout en préservant au moins 2 actions persist par goblin pour maintenir la cohérence.

**`sweepForDays(days, max, dryrun)`** - Stratégie combinée qui garde un maximum d'actions récentes et une seule action pour les données plus anciennes que le nombre de jours spécifié.

Toutes les méthodes supportent un mode `dryrun` pour prévisualiser les suppressions sans les effectuer et incluent des optimisations automatiques (ANALYZE, VACUUM) pour les gros volumes. Le système de logging détaillé permet de suivre les performances et les résultats des opérations.

### `lib/streamSQL.js` - Streaming de données

Classes pour le traitement efficace de grandes quantités de données :

#### `ReadableSQL`

Stream lisible pour extraire des données SQLite par lots avec gestion de l'itération asynchrone et configuration du pas de lecture (128 lignes par défaut). Supporte l'attente asynchrone pour les opérations SQLite et la gestion propre de la fin de stream.

#### `WritableSQL`

Stream inscriptible pour insertion en lots avec gestion automatique des transactions par blocs (configurable, 1024 insertions par défaut) et optimisation des performances via des commits périodiques. Inclut la gestion des erreurs et le nettoyage automatique des ressources.

### `lib/index.js` - Instance singleton

Exporte une instance unique de la classe Cryo configurée avec les paramètres du module `xcraft-core-etc`.

### `lib/endpoints/googleQueue.js` - Intégration Google Cloud

Endpoint pour publier les actions dans Google Cloud Pub/Sub :

**Fonctionnalités :**

- Configuration automatique des credentials Google Cloud via variable d'environnement
- Publication avec métadonnées complètes (timestamp, goblin, version, origin)
- Support de l'ordonnancement des messages avec clé configurable
- Gestion robuste des erreurs de publication avec logging détaillé

**`freeze(resp, msg, results)`** - Publie une action dans Google Pub/Sub avec les attributs appropriés et la clé d'ordonnancement configurée. Ajoute automatiquement les métadonnées d'origine et de timestamp de publication.

### `lib/sqlite-vec/loader.js` - Chargement d'extension vectorielle

Module pour charger l'extension SQLite de recherche vectorielle :

**Fonctionnalités :**

- Détection automatique de la plateforme et architecture (Linux, macOS, Windows)
- Support des architectures x86_64 et aarch64
- Gestion des erreurs avec messages explicites pour plateformes non supportées
- Chargement dynamique sécurisé avec vérification d'existence des fichiers
- Support des applications Electron avec gestion des chemins unpacked

**`load(db)`** - Charge l'extension vec0 dans une instance de base de données SQLite avec résolution automatique du chemin selon la plateforme.

**`getLoadablePath()`** - Résout le chemin vers l'extension SQLite-vec selon la plateforme et l'architecture détectées.

### `lib/sqlite-vec/worker.js` - Worker pour embeddings

Worker thread dédié au traitement des embeddings vectoriels :

**Fonctionnalités :**

- Traitement isolé dans un thread séparé pour éviter le blocage du thread principal
- Conversion automatique des embeddings hexadécimaux en vecteurs flottants 32 bits
- Support du partitionnement par locale avec fallback sur la locale par défaut configurée
- Nettoyage automatique des ressources et gestion des signaux système (SIGTERM)
- Suppression et réinsertion automatique des embeddings lors des mises à jour d'entités
- Gestion robuste des erreurs avec logging détaillé

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

Cette structure permet des recherches vectorielles efficaces avec partitionnement par locale et métrique de distance cosinus pour la similarité sémantique. Les embeddings sont extraits du champ `meta.vectors` des actions persist et convertis depuis leur format hexadécimal vers des vecteurs flottants.

Le worker traite automatiquement les messages contenant un identifiant de goblin et extrait les embeddings de la dernière action persist correspondante pour les insérer dans la table vectorielle.

### `test/soulSweeper.nospec.js` - Exemple d'utilisation

Fichier d'exemple montrant l'utilisation directe de SoulSweeper pour le nettoyage de bases de données :

```javascript
const {SQLite} = require('xcraft-core-book');
const SoulSweeper = require('../lib/soulSweeper.js');

const dbName = 'my_database';
const dbLocation = '/mnt/somewhere';

const sqlite = new SQLite(dbLocation);
sqlite.open(dbName, '', {});

const handle = sqlite.getHandle(dbName)();
const soulSweeper = new SoulSweeper(handle, dbName);
soulSweeper.sweepForDays(30, 10, false);
```

---

_Cette documentation a été mise à jour automatiquement à partir des sources du module xcraft-core-cryo._

[xcraft-core-book]: https://github.com/Xcraft-Inc/xcraft-core-book
[xcraft-core-utils]: https://github.com/Xcraft-Inc/xcraft-core-utils
[xcraft-core-fs]: https://github.com/Xcraft-Inc/xcraft-core-fs
[xcraft-core-transport]: https://github.com/Xcraft-Inc/xcraft-core-transport
[xcraft-core-etc]: https://github.com/Xcraft-Inc/xcraft-core-etc
[xcraft-core-goblin]: https://github.com/Xcraft-Inc/xcraft-core-goblin
[xcraft-core-host]: https://github.com/Xcraft-Inc/xcraft-core-host