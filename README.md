# 📘 Documentation du module xcraft-core-cryo

## Aperçu

Le module `xcraft-core-cryo` est une couche de persistance sophistiquée pour l'écosystème Xcraft, basée sur SQLite. Il implémente un système d'event sourcing qui permet de sauvegarder, récupérer et gérer l'historique des mutations d'état des acteurs Goblin et Elf. Ce module est fondamental pour la persistance des données dans les applications Xcraft, offrant des fonctionnalités avancées comme la recherche plein texte (FTS) et vectorielle (VEC).

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Configuration](#configuration)
- [API des commandes](#api-des-commandes)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
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

## Configuration

Le module utilise un fichier `config.js` qui définit les options configurables via `xcraft-core-etc` :

### Options principales

| Option                     | Description                                             | Type    | Valeur par défaut |
| -------------------------- | ------------------------------------------------------- | ------- | ----------------- |
| `journal`                  | Mode journal pour SQLite (journal ou WAL)              | String  | "WAL"             |
| `endpoints`                | Liste des endpoints à activer                           | Array   | []                |
| `enableFTS`                | Activer la recherche plein texte                        | Boolean | false             |
| `enableVEC`                | Activer la recherche vectorielle (nécessite enableFTS)  | Boolean | false             |

### Configuration FTS (Full Text Search)

| Option      | Description                                    | Type  | Valeur par défaut |
| ----------- | ---------------------------------------------- | ----- | ----------------- |
| `fts.list`  | Liste des bases de données où utiliser FTS    | Array | []                |

### Configuration VEC (Vector Search)

| Option              | Description                                     | Type   | Valeur par défaut |
| ------------------- | ----------------------------------------------- | ------ | ----------------- |
| `vec.list`          | Liste des bases de données où utiliser VEC     | Array  | []                |
| `vec.dimensions`    | Nombre de dimensions pour les embeddings       | Number | 4096              |
| `vec.defaultLocale` | Locale par défaut pour le partitionnement      | String | "fr"              |

### Configuration avancée

| Option                     | Description                                      | Type   | Valeur par défaut |
| -------------------------- | ------------------------------------------------ | ------ | ----------------- |
| `migrations.cleanings`     | Règles de nettoyage par nom de base de données  | Object | null              |
| `enableTimetable`          | Activer la table de temps                       | Boolean| false             |
| `googleQueue.topic`        | Topic pour publier les messages                 | String | ""                |
| `googleQueue.authFile`     | Fichier d'authentification pour Google Queue    | String | ""                |
| `googleQueue.orderingPrefix` | Partie fixe de la clé d'ordonnancement        | String | ""                |

## API des commandes

Le module expose les commandes suivantes via `xcraftCommands` :

### Commandes de base

- **`freeze`** : Persiste une action dans la base de données
- **`thaw`** : Récupère les actions jusqu'à un timestamp donné
- **`frozen`** : Obtient des statistiques sur les actions gelées
- **`isEmpty`** : Teste si une base de données est vide
- **`usable`** : Vérifie si Cryo est utilisable

### Commandes de gestion

- **`restore`** : Restaure une base de données à un timestamp particulier
- **`branch`** : Crée une nouvelle branche de la base de données
- **`branches`** : Liste toutes les branches disponibles
- **`actions`** : Liste les actions entre deux timestamps
- **`getEntityTypeCount`** : Retourne les types de goblin et leur nombre

### Commandes de transaction

- **`immediate`** : Démarre une transaction immédiate
- **`exclusive`** : Démarre une transaction exclusive
- **`commit`** : Valide la transaction en cours
- **`rollback`** : Annule la transaction en cours

### Commandes de synchronisation

- **`getDataForSync`** : Obtient les actions en attente et le dernier ID de commit
- **`prepareDataForSync`** : Marque les actions avec l'ID de commit zéro
- **`updateActionsAfterSync`** : Met à jour les actions après synchronisation
- **`hasCommitId`** : Teste si un commitId existe
- **`getLastCommitId`** : Obtient le dernier commitId

### Commandes de nettoyage

- **`sweep`** : Nettoie les anciennes actions (paramètres par défaut)
- **`sweepByMaxCount`** : Nettoie en gardant un maximum d'actions par goblin

### Commandes utilitaires

- **`loadMiddleware`** : Charge et ajoute un nouveau middleware
- **`registerLastActionTriggers`** : Enregistre des topics d'événements à déclencher
- **`bootstrapActions`** : Gèle un lot d'actions
- **`hasGoblin`** : Vérifie si un goblin existe

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
            status: 'published'
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

## Interactions avec d'autres modules

- **[xcraft-core-book]** : Fournit la classe SQLite utilisée par Cryo
- **[xcraft-core-utils]** : Utilisé pour les verrous et autres utilitaires
- **[xcraft-core-fs]** : Gestion des fichiers et répertoires
- **[xcraft-core-transport]** : Streaming des données
- **[xcraft-core-etc]** : Configuration du module
- **[xcraft-core-goblin]** : Les acteurs Goblin utilisent Cryo pour persister leur état
- **[xcraft-core-host]** : Informations sur l'environnement d'exécution
- **@google-cloud/pubsub** : Utilisé par l'endpoint GoogleQueue pour la publication de messages

## Détails des sources

### `cryo.js` - Classe principale

La classe `Cryo` hérite de `SQLite` et implémente toutes les fonctionnalités de persistance :

#### Propriétés importantes

- `#soulSweeper` : Instances de SoulSweeper par base de données
- `#worker` : Map des worker threads pour les embeddings vectoriels
- `_middleware` : Fonction middleware pour transformer les données
- `_lastActionTriggers` : Triggers pour les notifications d'événements

#### Méthodes de persistance

- **`freeze(resp, msg)`** : Persiste une action avec gestion des règles et des types
- **`thaw(resp, msg)`** : Récupère les actions avec support de pagination
- **`frozen(resp, msg)`** : Statistiques sur les actions gelées

#### Méthodes de transaction

- **`immediate(resp, msg)`** : Transaction immédiate avec verrous
- **`exclusive(resp, msg)`** : Transaction exclusive
- **`commit(resp, msg)`** : Validation avec envoi des notifications en attente
- **`rollback(resp, msg)`** : Annulation de transaction

#### Gestion des bases de données

- **`_open(dbName, resp)`** : Ouverture avec migration automatique du schéma
- **`branch(resp, msg)`** : Création de branches avec horodatage
- **`restore(resp, msg)`** : Restauration à un point dans le temps

### `soulSweeper.js` - Nettoyage des données

Utilitaire spécialisé pour l'optimisation des bases de données :

#### Stratégies de nettoyage

- **`sweepByCount(count, dryrun)`** : Garde un nombre spécifique d'actions persist par goblin
- **`sweepByDatetime(datetime, dryrun)`** : Supprime les actions antérieures à une date
- **`sweepForDays(days, max, dryrun)`** : Stratégie combinée pour un historique récent détaillé

#### Optimisations

- Requêtes SQL optimisées avec CTE (Common Table Expressions)
- Support du mode dry-run pour prévisualiser les suppressions
- VACUUM automatique après suppressions importantes
- Analyse et optimisation des indices

### `streamSQL.js` - Streaming de données

Classes pour le traitement efficace de grandes quantités de données :

#### `ReadableSQL`

- Stream lisible pour extraire des données SQLite par lots
- Gestion de l'itération avec `#step` configurable
- Support des opérations asynchrones avec `#wait`

#### `WritableSQL`

- Stream inscriptible pour insertion en lots
- Gestion automatique des transactions par blocs
- Optimisation des performances avec des commits périodiques

### `endpoints/googleQueue.js` - Intégration Google Cloud

Endpoint pour publier les actions dans Google Cloud Pub/Sub :

- **Configuration** : Authentification via fichier de credentials
- **Publication** : Messages avec métadonnées et ordonnancement
- **Attributs** : Horodatage, goblin, version pour le filtrage
- **Gestion d'erreurs** : Logging des échecs de publication

### `sqlite-vec/` - Recherche vectorielle

#### `loader.js` - Chargement d'extension

- Détection automatique de la plateforme (Linux, macOS, Windows)
- Support multi-architecture (x86_64, aarch64)
- Gestion des erreurs avec messages explicites
- Chargement dynamique de l'extension SQLite

#### `worker.js` - Traitement des embeddings

Worker thread pour les opérations vectorielles :

- **Isolation** : Traitement dans un thread séparé
- **Embedding** : Conversion et insertion des vecteurs
- **Partitionnement** : Support des locales pour les performances
- **Gestion du cycle de vie** : Nettoyage automatique des ressources

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

Cette structure permet des recherches vectorielles efficaces avec partitionnement par locale et métrique de distance cosinus pour la similarité sémantique.

---

_Cette documentation a été générée automatiquement à partir des sources du module xcraft-core-cryo._

[xcraft-core-book]: https://github.com/Xcraft-Inc/xcraft-core-book
[xcraft-core-utils]: https://github.com/Xcraft-Inc/xcraft-core-utils
[xcraft-core-fs]: https://github.com/Xcraft-Inc/xcraft-core-fs
[xcraft-core-transport]: https://github.com/Xcraft-Inc/xcraft-core-transport
[xcraft-core-etc]: https://github.com/Xcraft-Inc/xcraft-core-etc
[xcraft-core-goblin]: https://github.com/Xcraft-Inc/xcraft-core-goblin
[xcraft-core-host]: https://github.com/Xcraft-Inc/xcraft-core-host