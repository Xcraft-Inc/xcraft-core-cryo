# 📘 Documentation du module xcraft-core-cryo

## Aperçu

Le module `xcraft-core-cryo` est une couche de persistance sophistiquée pour l'écosystème Xcraft, basée sur SQLite. Il implémente un système d'event sourcing qui permet de sauvegarder, récupérer et gérer l'historique des mutations d'état des acteurs Goblin et Elf. Ce module est fondamental pour la persistance des données dans les applications Xcraft, offrant des fonctionnalités avancées comme la recherche plein texte et vectorielle.

## Structure du module

- **Cryo** : Classe principale qui encapsule les fonctionnalités de persistance et de récupération
- **SoulSweeper** : Utilitaire pour nettoyer les anciennes actions et optimiser la base de données
- **StreamSQL** : Classes pour la lecture/écriture de flux de données SQL
- **Endpoints** : Extensions pour connecter Cryo à d'autres systèmes (comme Google Queue)
- **SQLite-Vec** : Support pour la recherche vectorielle via une extension SQLite

Le module expose une API complète pour la gestion des actions, avec des fonctionnalités de:

- Persistance (`freeze`)
- Récupération (`thaw`)
- Synchronisation et transactions
- Recherche plein texte (FTS) et vectorielle (VEC)
- Nettoyage et optimisation des données

## Fonctionnement global

Cryo fonctionne selon le principe d'event sourcing :

1. Les actions (événements) sont "gelées" (`freeze`) dans la base de données SQLite
2. Chaque action contient les informations nécessaires pour reconstruire l'état d'un acteur
3. Les actions peuvent être "dégelées" (`thaw`) pour reconstruire l'état à un moment précis
4. Le système maintient un historique complet des changements

Les actions sont stockées avec des métadonnées :

- `timestamp` : Horodatage de l'action
- `goblin` : Identifiant de l'acteur concerné
- `action` : Contenu JSON de l'action
- `version` : Version de l'application
- `type` : Type d'action (create, persist, etc.)
- `commitId` : Identifiant de commit pour la synchronisation

Le module offre également des fonctionnalités avancées comme :

- Recherche plein texte via SQLite FTS5
- Recherche vectorielle pour les embeddings (avec dimensions configurables)
- Synchronisation des actions entre différentes instances
- Nettoyage automatique des anciennes actions via SoulSweeper
- Transactions et verrous pour garantir la cohérence des données
- Support pour les worker threads pour le traitement des embeddings

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
  await cryo.thaw({
    db: 'myDatabase',
    timestamp: '2023-05-01T12:00:00.000Z'
  });

  // Les résultats sont envoyés via des événements
  // resp.events.send('cryo.thawed.myDatabase', rows);
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
      action: {/* ... */},
      rules: {/* ... */}
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
    dbs: ['myDatabase'],
    days: 30,
    max: 10
  });
  console.log(changes); // Nombre d'actions supprimées par base de données
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

| Option                     | Description                                             | Type    | Valeur par défaut |
| -------------------------- | ------------------------------------------------------- | ------- | ----------------- |
| journal                    | Mode journal pour SQLite                                | String  | "WAL"             |
| endpoints                  | Liste des endpoints à activer                           | Array   | []                |
| enableFTS                  | Activer la recherche plein texte                        | Boolean | false             |
| enableVEC                  | Activer la recherche vectorielle (nécessite enableFTS)  | Boolean | false             |
| fts.list                   | Liste des bases de données où utiliser FTS              | Array   | []                |
| vec.list                   | Liste des bases de données où utiliser VEC              | Array   | []                |
| vec.dimensions             | Nombre de dimensions pour les embeddings                | Number  | 4096              |
| vec.defaultLocale          | Locale par défaut pour le partitionnement des vecteurs  | String  | "fr"              |
| migrations.cleanings       | Règles de nettoyage par nom de base de données          | Object  | null              |
| enableTimetable            | Activer la table de temps pour des requêtes temporelles | Boolean | false             |
| googleQueue.topic          | Topic à utiliser pour publier les messages              | String  | ""                |
| googleQueue.authFile       | Fichier d'authentification pour Google Queue            | String  | ""                |
| googleQueue.orderingPrefix | Partie fixe de la clé d'ordonnancement                  | String  | ""                |

### Variables d'environnement

| Variable                       | Description                                      | Exemple              | Valeur par défaut                                 |
| ------------------------------ | ------------------------------------------------ | -------------------- | ------------------------------------------------- |
| GOOGLE_APPLICATION_CREDENTIALS | Chemin vers le fichier d'authentification Google | "/path/to/auth.json" | Défini dynamiquement si googleQueue est configuré |

## Détails des sources

### `cryo.js`

Classe principale qui implémente toutes les fonctionnalités de Cryo. Elle gère :

- La connexion à SQLite et la définition du schéma de base de données
- Les requêtes SQL pour les différentes opérations (freeze, thaw, etc.)
- Les middlewares pour transformer les données
- Les transactions et verrous pour garantir la cohérence
- Les triggers pour les notifications d'événements
- La gestion des indices et des optimisations

La classe expose de nombreuses méthodes comme `freeze`, `thaw`, `frozen`, `restore`, etc., qui sont exposées via l'API Xcraft. Elle gère également les migrations de schéma lors des mises à jour.

#### Méthodes publiques

- **`freeze(resp, msg)`** - Persiste une action dans la base de données. Prend un objet action et des règles de persistance.
- **`thaw(resp, msg)`** - Récupère les actions de la base de données jusqu'à un timestamp donné.
- **`frozen(resp, msg)`** - Obtient des statistiques sur les actions gelées.
- **`restore(resp, msg)`** - Restaure une base de données à un timestamp particulier.
- **`branch(resp, msg)`** - Crée une nouvelle branche de la base de données.
- **`branches(resp)`** - Liste toutes les branches disponibles pour toutes les bases de données.
- **`actions(resp, msg)`** - Liste les actions entre deux timestamps.
- **`getEntityTypeCount(resp, msg)`** - Retourne les types de goblin et leur nombre.
- **`sweep(resp, msg)`** - Nettoie les anciennes actions selon les paramètres par défaut.
- **`sweepByMaxCount(resp, msg)`** - Nettoie les anciennes actions en gardant un maximum d'actions par goblin.
- **`immediate(resp, msg)`** - Démarre une transaction immédiate.
- **`exclusive(resp, msg)`** - Démarre une transaction exclusive.
- **`commit(resp, msg)`** - Valide la transaction en cours.
- **`rollback(resp, msg)`** - Annule la transaction en cours.
- **`registerLastActionTriggers(resp, msg)`** - Enregistre des topics d'événements à déclencher.
- **`getDataForSync(resp, msg)`** - Obtient les actions en attente et le dernier ID de commit.
- **`bootstrapActions(resp, msg, next)`** - Gèle un lot d'actions.

### `soulSweeper.js`

Utilitaire spécialisé pour nettoyer les anciennes actions et optimiser la base de données :

- `sweepByCount` : Garde un nombre spécifique d'actions par acteur (entre 1 et 100)
- `sweepByDatetime` : Supprime les actions antérieures à une date spécifique
- `sweepForDays` : Stratégie combinée pour garder un historique récent plus détaillé

Le SoulSweeper utilise des requêtes SQL optimisées pour identifier et supprimer les actions obsolètes tout en préservant l'intégrité des données. Il inclut également des fonctionnalités pour analyser et optimiser la base de données après le nettoyage.

#### Méthodes publiques

- **`sweepByCount(count = 4, dryrun = true)`** - Nettoie en gardant un nombre spécifique d'actions persist par goblin.
- **`sweepByDatetime(datetime = this.#sqlite.timestamp(), dryrun = true)`** - Nettoie les actions antérieures à une date donnée.
- **`sweepForDays(days = 30, max = 10, dryrun = true)`** - Stratégie combinée pour garder un historique récent plus détaillé.

### `streamSQL.js`

Classes pour la lecture/écriture de flux de données SQL :

- `ReadableSQL` : Stream lisible pour extraire des données de SQLite par lots
- `WritableSQL` : Stream inscriptible pour insérer des données dans SQLite avec gestion des transactions

Ces classes permettent de traiter efficacement de grandes quantités de données sans surcharger la mémoire, en utilisant le système de streaming de Node.js.

### `endpoints/googleQueue.js`

Endpoint pour publier des actions dans Google Cloud Pub/Sub :

- Publie les actions gelées dans un topic Google Cloud
- Ajoute des métadonnées comme l'horodatage et l'identifiant de l'acteur
- Gère l'authentification via un fichier de credentials
- Supporte l'ordonnancement des messages pour garantir leur traitement séquentiel

### `sqlite-vec/loader.js`

Chargeur pour l'extension SQLite de recherche vectorielle :

- Détecte la plateforme et l'architecture du système
- Charge l'extension appropriée pour la recherche vectorielle
- Supporte différentes plateformes (Linux, macOS, Windows) et architectures (x86_64, aarch64)
- Gère les erreurs de chargement avec des messages explicites

### `sqlite-vec/worker.js`

Worker thread pour le traitement des embeddings vectoriels :

- Exécute les opérations d'embedding dans un thread séparé
- Gère l'insertion et la mise à jour des vecteurs dans la table `embeddings`
- Utilise la fonction `vec_f32` pour convertir les données binaires en vecteurs
- Supporte le partitionnement par locale pour améliorer les performances

La table `embeddings` est structurée comme suit :

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

Cette structure permet des recherches vectorielles efficaces avec partitionnement par locale pour améliorer les performances.

_Cette documentation a été mise à jour automatiquement._

[xcraft-core-book]: https://github.com/Xcraft-Inc/xcraft-core-book
[xcraft-core-utils]: https://github.com/Xcraft-Inc/xcraft-core-utils
[xcraft-core-fs]: https://github.com/Xcraft-Inc/xcraft-core-fs
[xcraft-core-transport]: https://github.com/Xcraft-Inc/xcraft-core-transport
[xcraft-core-etc]: https://github.com/Xcraft-Inc/xcraft-core-etc
[xcraft-core-goblin]: https://github.com/Xcraft-Inc/xcraft-core-goblin
[xcraft-core-host]: https://github.com/Xcraft-Inc/xcraft-core-host