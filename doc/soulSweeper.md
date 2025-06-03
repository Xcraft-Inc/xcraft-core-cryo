# Cryo et SoulSweeper

## Aperçu

Le module **xcraft-core-cryo** est un système de persistance d'actions basé sur SQLite qui fait partie du framework Xcraft. Il fournit un mécanisme de stockage pour les actions des acteurs (Elf et Goblin) avec des fonctionnalités avancées de nettoyage automatique via le **SoulSweeper**.

Le SoulSweeper est un composant spécialisé dans l'optimisation et le nettoyage des bases de données Cryo en supprimant intelligemment les anciennes actions tout en préservant l'intégrité des données et l'historique nécessaire. Il opère selon des stratégies sophistiquées qui équilibrent la conservation de l'historique avec l'optimisation de l'espace disque et des performances.

## Sommaire

### Fonctionnement

- [Architecture du SoulSweeper](#architecture-du-soulsweeper)
- [Stratégies de nettoyage](#stratégies-de-nettoyage)
- [Requêtes SQL de nettoyage](#requêtes-sql-de-nettoyage)
- [Mécanismes de sécurité et validation](#mécanismes-de-sécurité-et-validation)
- [Optimisation des performances](#optimisation-des-performances)
- [Intégration avec Cryo](#intégration-avec-cryo)
- [Gestion des environnements synchronisés](#gestion-des-environnements-synchronisés)

### La requête SQL

- [Anatomie de la requête de nettoyage par nombre](#anatomie-de-la-requête-de-nettoyage-par-nombre)

## Fonctionnement

### Architecture du SoulSweeper

Le SoulSweeper est une classe autonome qui opère directement sur les bases de données SQLite de Cryo. Il est instancié pour chaque base de données ouverte dans le constructeur de Cryo et maintient un ensemble de requêtes SQL préparées pour optimiser les performances.

La classe encapsule trois types d'opérations principales :

- **Nettoyage par nombre** : Conservation d'un nombre fixe d'actions persist par goblin
- **Nettoyage par date** : Suppression des actions antérieures à une date donnée
- **Stratégie hybride** : Combinaison des deux approches pour un nettoyage optimal

Le SoulSweeper distingue automatiquement les environnements avec et sans synchronisation. Dans les environnements synchronisés, il ne touche qu'aux actions ayant un `commitId` non nul, préservant ainsi les actions en cours de synchronisation ou non encore synchronisées.

L'architecture utilise un système de requêtes préparées avec patching dynamique selon le contexte de synchronisation, permettant une adaptation transparente aux différents modes de fonctionnement.

Le SoulSweeper intègre également un système de mesure temporelle précis utilisant `hrtime.bigint()` pour monitorer les performances et optimiser les opérations de maintenance. Il génère des logs contextuels différenciés selon le mode d'exécution (dry-run vs réel) pour faciliter le debugging et l'audit des opérations.

### Stratégies de nettoyage

#### Nettoyage par nombre d'actions (sweepByCount)

Cette stratégie conserve un nombre défini d'actions persist par goblin, avec une limite stricte entre 1 et 100 actions (par défaut 4). Le processus fonctionne selon cette logique sophistiquée :

Pour chaque goblin, le système identifie toutes les actions persist avec un commitId valide, puis détermine quelles actions peuvent être supprimées en conservant les N plus récentes. La suppression inclut toutes les actions intermédiaires entre les actions persist supprimées, préservant ainsi la cohérence de l'historique.

La stratégie utilise une technique d'union avec des valeurs nulles générées artificiellement pour garantir qu'au moins N actions persist sont conservées, même si le goblin en possède moins. Cette approche évite les suppressions accidentelles dans les cas limites.

La méthode retourne le nombre exact d'actions supprimées et peut fonctionner en mode dry-run pour validation préalable. Elle déclenche automatiquement les optimisations de base de données (ANALYZE et VACUUM conditionnel) selon l'ampleur des modifications.

#### Nettoyage par date (sweepByDatetime)

Cette stratégie supprime les actions persist antérieures à une date donnée, en conservant au minimum les deux dernières actions persist par goblin. Le mécanisme garantit qu'aucun goblin ne se retrouve sans historique récent, même si toutes ses actions sont antérieures à la date limite.

La logique de sélection identifie pour chaque goblin la première action persist à supprimer et la dernière action persist dans la plage de suppression. Le système utilise une union avec des valeurs nulles pour forcer la conservation d'au moins deux actions récentes par goblin.

La date peut être fournie sous format ISO string ou générée automatiquement via `this.#sqlite.timestamp()`. La validation temporelle s'assure de la cohérence des paramètres avant exécution.

#### Stratégie hybride (sweepForDays)

Cette approche combine les deux méthodes précédentes pour créer une stratégie de rétention optimale en deux phases :

1. **Phase de limitation** : Conservation d'un maximum de N actions persist par goblin (par défaut 10)
2. **Phase temporelle** : Conservation de toutes les actions des N derniers jours (par défaut 30), puis conservation d'au moins une action persist pour les données plus anciennes

Cette stratégie permet de maintenir un historique détaillé récent tout en préservant une trace historique à long terme, optimisant ainsi l'équilibre entre performance et conservation des données.

La méthode calcule automatiquement la date limite en soustrayant le nombre de jours spécifié à la date courante, puis applique séquentiellement les deux stratégies en additionnant leurs résultats.

### Requêtes SQL de nettoyage

#### Structure des requêtes de nettoyage par nombre

La requête principale utilise une architecture complexe en plusieurs étapes pour identifier précisément les actions à supprimer. Le processus commence par sélectionner toutes les actions liées aux goblins concernés, puis utilise une jointure avec une sous-requête qui calcule les actions persist à conserver.

La sous-requête interne identifie d'abord les actions persist dans la plage de suppression pour chaque goblin. Cette plage est délimitée par la première action persist à supprimer et la N-ième action persist à conserver en partant de la fin. Le système utilise une technique sophistiquée avec 100 valeurs nulles générées artificiellement pour garantir la conservation du nombre requis d'actions, même dans les cas où un goblin possède moins d'actions que le seuil de conservation.

La jointure externe permet ensuite de sélectionner toutes les actions du goblin dont le rowid est inférieur au maximum des actions à conserver, incluant ainsi toutes les actions intermédiaires entre les actions persist supprimées.

#### Structure des requêtes de nettoyage par date

Ces requêtes suivent un pattern similaire mais utilisent un critère temporel avec protection automatique. Le système identifie pour chaque goblin la première action persist à supprimer et calcule la dernière action persist dans la plage de suppression en excluant automatiquement les deux plus récentes.

La protection est assurée par une union avec des valeurs nulles qui force la conservation d'au moins deux actions persist récentes par goblin. Cette approche garantit qu'aucun goblin ne perd complètement son historique, même si toutes ses actions sont antérieures à la date limite spécifiée.

La condition temporelle `timestamp < $datetime` est appliquée dans la sous-requête de sélection des actions candidates, permettant un filtrage précis basé sur la date fournie en paramètre.

#### Gestion des environnements avec/sans synchronisation

Le SoulSweeper adapte automatiquement ses requêtes selon le contexte via une méthode de patching appliquée lors de l'initialisation. Dans les environnements avec synchronisation, la condition `AND commitId IS NOT NULL` est conservée pour préserver les actions non synchronisées. Dans les environnements sans synchronisation, cette condition est supprimée via `replaceAll` pour traiter toutes les actions sans distinction.

Cette adaptation transparente permet au SoulSweeper de fonctionner optimalement dans tous les contextes sans nécessiter de configuration manuelle. Le paramètre `withCommits` est déterminé automatiquement lors de l'instanciation selon la configuration de synchronisation détectée.

### Mécanismes de sécurité et validation

#### Mode dry-run obligatoire par défaut

Toutes les opérations de nettoyage sont configurées en mode dry-run par défaut, nécessitant une activation explicite pour les suppressions réelles. Ce mode exécute les requêtes de comptage sans aucune modification, retourne le nombre exact d'actions qui seraient supprimées, permet la validation complète des stratégies avant exécution et génère des logs détaillés pour l'audit des opérations.

Les méthodes de dry-run utilisent des requêtes spécifiques suffixées par `Dryrun` qui comptent les actions candidates sans les supprimer, permettant une évaluation précise de l'impact avant exécution réelle.

#### Validation stricte des paramètres

Le SoulSweeper implémente une validation rigoureuse avec vérification stricte de la plage 1-100 pour le nombre d'actions avec exception en cas de dépassement, validation du format ISO et cohérence temporelle automatique pour les dates, et vérification de l'existence et de l'accessibilité des bases de données avant traitement.

La validation du paramètre `count` lève une exception explicite si la valeur est hors de la plage autorisée, empêchant les opérations potentiellement dangereuses ou inefficaces.

#### Préservation garantie de l'intégrité

Le système implémente plusieurs mécanismes de protection : garantie qu'aucun goblin ne perd complètement son historique, préservation automatique des actions avec commitId null, conservation des actions intermédiaires entre les actions persist conservées, et atomicité de toutes les opérations via des transactions.

Les requêtes SQL intègrent des mécanismes de protection par construction, utilisant des unions avec valeurs nulles et des conditions de jointure spécifiques pour éviter les suppressions excessives.

### Optimisation des performances

#### Analyse et optimisation automatique

Le SoulSweeper implémente un système d'optimisation en trois phases distinctes. La phase de pré-traitement exécute `PRAGMA analysis_limit = 1000` pour limiter l'analyse, puis `ANALYZE` pour mettre à jour les statistiques de la base de données. La phase de traitement exécute les requêtes de nettoyage optimisées. La phase de post-traitement déclenche un VACUUM conditionnel pour les suppressions importantes.

Ces opérations sont encapsulées dans les méthodes privées `#before()` et `#after()` qui s'exécutent automatiquement selon le mode d'opération et l'ampleur des modifications détectées.

#### VACUUM conditionnel intelligent

Le système déclenche automatiquement VACUUM selon des critères précis. Le seuil de déclenchement est fixé à plus de 100 000 lignes supprimées. Le système effectue une mesure temporelle précise du temps d'exécution avec `hrtime.bigint()`, génère un logging détaillé pour enregistrer les performances et optimiser les futures opérations, et procède à la récupération d'espace en optimisant la structure physique de la base.

Le VACUUM n'est jamais exécuté en mode dry-run, évitant les opérations coûteuses inutiles lors des phases de validation.

#### Architecture de requêtes préparées

Toutes les requêtes SQL sont préparées au moment de l'initialisation, éliminant le coût de compilation répétitif, permettant la réutilisation des plans d'exécution optimisés, améliorant significativement les performances pour les opérations répétées, et optimisant la gestion mémoire par la réutilisation efficace des structures compilées.

Les requêtes sont stockées dans des propriétés privées de classe (préfixées par `#`) et préparées une seule fois lors de l'instanciation, garantissant des performances optimales pour les opérations répétées.

#### Système de mesure temporelle précis

Le SoulSweeper intègre un monitoring avancé utilisant `hrtime.bigint()` pour une mesure ultra-précise à la nanoseconde. Le logging contextuel différencie les logs selon le mode (dry-run vs réel). Le monitoring des opérations coûteuses assure un suivi spécifique des opérations VACUUM. Les métriques de performance permettent la collecte de données pour une optimisation continue.

La méthode privée `#time()` convertit les mesures en secondes avec une précision de trois décimales, facilitant l'interprétation des performances dans les logs.

### Intégration avec Cryo

#### Instanciation automatique et gestion du cycle de vie

Chaque base de données Cryo dispose de son propre SoulSweeper via une architecture intégrée. La création est automatique lors de l'ouverture de chaque base dans la méthode `_open()`. La configuration s'adapte automatiquement selon `_useSync` pour la gestion des commitId. Le stockage est centralisé dans `#soulSweeper[dbName]` pour un accès direct. Le nettoyage automatique libère les ressources lors de la fermeture.

L'instanciation se fait avec les paramètres `(this._db[dbName], dbName, this._useSync)`, transmettant le handle SQLite, le nom de la base et le mode de synchronisation détecté.

#### Commandes exposées sur le bus Xcraft

Le système Cryo expose plusieurs commandes de nettoyage via `xcraftCommands`. La commande `sweep` implémente la stratégie hybride avec paramètres par défaut (30 jours, max 10 actions). La commande `sweepByMaxCount` effectue un nettoyage par nombre d'actions uniquement.

Ces commandes acceptent des paramètres optionnels : `dbs` pour spécifier la liste des bases à traiter (toutes par défaut via `this.getAllNames()`), `max` pour définir le nombre maximum d'actions à conserver, et `days` pour spécifier le nombre de jours pour la stratégie temporelle.

Les commandes retournent un objet structuré avec les résultats par base de données, permettant un suivi précis des opérations de nettoyage.

#### Gestion robuste des erreurs

L'intégration inclut une gestion d'erreurs multi-niveaux avec isolation des erreurs par base de données sans interruption globale, continuation du service pour traiter les autres bases même en cas d'échec ponctuel, logging détaillé avec enregistrement complet des erreurs incluant la stack trace, et reporting structuré retournant les résultats par base avec indication des succès et échecs.

Les boucles de traitement utilisent des blocs try-catch individuels pour chaque base, garantissant qu'une erreur sur une base n'interrompt pas le traitement des autres.

### Gestion des environnements synchronisés

#### Détection automatique du mode de synchronisation

Le SoulSweeper s'adapte automatiquement selon la configuration Cryo en lisant `goblinConfig.actionsSync?.enable` pour détecter le mode, en adaptant automatiquement les requêtes SQL selon le contexte via patching, et en préservant automatiquement les actions avec `commitId` null.

La détection se fait dans le constructeur de Cryo via `this._useSync = !!goblinConfig.actionsSync?.enable`, puis transmise au SoulSweeper lors de l'instanciation.

#### Stratégies spécifiques aux environnements synchronisés

Dans les environnements avec synchronisation active, le système protège les actions en cours en préservant systématiquement les actions avec `commitId` null, respecte les cycles de synchronisation en ne traitant que les actions avec `commitId` valide comme candidates au nettoyage, et maintient la cohérence distribuée entre les différents nœuds du système.

Le patching des requêtes via la fonction `patch` applique ou supprime la condition `AND commitId IS NOT NULL` selon le contexte, garantissant une adaptation transparente aux deux modes de fonctionnement.

## La requête SQL

### Anatomie de la requête de nettoyage par nombre

La requête de nettoyage par nombre d'actions représente l'une des pièces maîtresses du SoulSweeper. Elle s'articule autour d'une architecture SQL complexe qui garantit la préservation de l'intégrité des données tout en optimisant l'espace de stockage.

#### Structure générale de la requête

```sql
DELETE FROM actions
WHERE rowid IN (
  -- Select all actions to delete
  SELECT rowid
  FROM actions
  LEFT JOIN (
    -- Select only the latest actions to collect
    SELECT max(rowid) AS max, goblinId
    FROM (
      -- Select all persist actions to collect
      SELECT rowid, goblin AS goblinId
      FROM actions
      WHERE rowid BETWEEN (
          -- Select the first action to remove
          SELECT rowid
          FROM actions
          WHERE goblin = goblinId
            AND type = 'persist'
            AND commitId IS NOT NULL
          ORDER BY rowid ASC
          LIMIT 1
        ) AND (
          -- Select the X'th older action to keep (we keep at least X actions)
          SELECT rowid
          FROM (
            SELECT rowid
            FROM actions
            WHERE goblin = goblinId
              AND type = 'persist'
              AND commitId IS NOT NULL
            UNION ALL
            SELECT NULL as rowid
            FROM (
              VALUES (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                     (0), (0), (0), (0), (0), (0), (0), (0), (0), (0) -- LIMIT X to 100 (max)
            )
            ORDER BY rowid DESC
            LIMIT $count -- PARAMETER -- Use 10 to keep 10 latest persist actions, etc.
          )
          ORDER BY rowid ASC
          LIMIT 1
        )
        AND type = 'persist'
        AND commitId IS NOT NULL
      ORDER BY goblin, rowid ASC
    )
    GROUP BY goblinId
  ) AS removeList
  WHERE actions.goblin = removeList.goblinId
    AND actions.rowid < removeList.max -- Here max is not in the collectable list
)
```

La requête principale suit un pattern de sélection en cascade qui commence par identifier toutes les actions candidates à la suppression, puis applique des filtres sophistiqués pour déterminer précisément quelles actions peuvent être supprimées en toute sécurité.

Le cœur de la logique repose sur une jointure externe entre la table `actions` et une sous-requête complexe nommée `removeList`. Cette jointure permet d'identifier pour chaque goblin les actions qui peuvent être supprimées tout en préservant un nombre minimum d'actions persist.

#### Sous-requête de calcul des actions à conserver

La sous-requête `removeList` constitue le cerveau de l'opération. Elle calcule pour chaque goblin l'action persist la plus récente qui peut être supprimée, en s'assurant qu'au moins N actions persist plus récentes sont conservées.

Cette sous-requête utilise une technique sophistiquée de regroupement par `goblinId` avec une fonction `max(rowid)` pour identifier l'action persist la plus ancienne dans la plage de suppression autorisée. Le calcul de cette plage implique deux bornes critiques : la première action persist du goblin et la N-ième action persist en partant de la fin.

La logique de groupement `GROUP BY goblinId` avec `max(rowid)` garantit qu'une seule valeur de référence est calculée par goblin, évitant les ambiguïtés dans la sélection des actions à supprimer.

#### Mécanisme de protection par valeurs nulles

L'une des innovations les plus remarquables de cette requête réside dans l'utilisation de 100 valeurs nulles générées artificiellement via une clause `VALUES`. Cette technique garantit qu'aucun goblin ne perd plus d'actions que le seuil autorisé, même dans les cas où il possède moins d'actions persist que la limite de conservation.

```sql
UNION ALL
SELECT NULL as rowid
FROM (
  VALUES (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
         -- ... 100 valeurs nulles au total
)
```

Les valeurs nulles sont injectées dans la sous-requête de sélection des actions à conserver, créant un "coussin de sécurité" qui empêche les suppressions excessives. Lorsque la requête tente de sélectionner la N-ième action en partant de la fin, les valeurs nulles comblent automatiquement les positions manquantes.

Cette approche élégante évite les conditions complexes et les vérifications de comptage, laissant le moteur SQL gérer naturellement les cas limites via le tri et la limitation des résultats.

#### Gestion des bornes de suppression

La détermination des bornes de suppression utilise une logique de fenêtrage sophistiquée. La borne inférieure est calculée en sélectionnant la première action persist du goblin avec un `commitId` valide :

```sql
SELECT rowid
FROM actions
WHERE goblin = goblinId
  AND type = 'persist'
  AND commitId IS NOT NULL
ORDER BY rowid ASC
LIMIT 1
```

La borne supérieure correspond à la N-ième action persist en partant de la fin, calculée via une sous-requête qui combine les actions réelles avec les valeurs nulles de protection :

```sql
SELECT rowid
FROM (
  SELECT rowid
  FROM actions
  WHERE goblin = goblinId
    AND type = 'persist'
    AND commitId IS NOT NULL
  UNION ALL
  SELECT NULL as rowid
  FROM (VALUES (...))
  ORDER BY rowid DESC
  LIMIT $count
)
ORDER BY rowid ASC
LIMIT 1
```

Cette approche garantit que même si un goblin possède exactement N actions persist, aucune ne sera supprimée, car la borne supérieure sera positionnée de manière à exclure toutes les actions de la plage de suppression.

Le double tri (`ORDER BY rowid DESC` puis `ORDER BY rowid ASC`) permet de sélectionner précisément la N-ième action en partant de la fin, puis de récupérer la plus ancienne de cette sélection comme borne de référence.

#### Jointure et sélection finale

La jointure externe finale utilise deux conditions critiques : l'égalité des identifiants de goblin et la comparaison des `rowid`. La condition `actions.rowid < removeList.max` (pour le nettoyage par nombre) ou `actions.rowid <= removeList.max` (pour le nettoyage par date) détermine précisément quelles actions sont incluses dans la suppression.

Cette différence subtile entre `<` et `<=` reflète la philosophie de chaque stratégie : le nettoyage par nombre exclut l'action de référence de la suppression, tandis que le nettoyage par date l'inclut, permettant une granularité différente dans la gestion de l'historique.

La jointure `LEFT JOIN` garantit que tous les goblins sont considérés, même ceux qui n'ont pas d'actions dans la plage de suppression, évitant les suppressions accidentelles par omission.

#### Adaptation dynamique pour la synchronisation

Le système de patching appliqué lors de l'initialisation modifie dynamiquement les requêtes selon le contexte de synchronisation. Dans les environnements synchronisés, la condition `AND commitId IS NOT NULL` est préservée dans toutes les sous-requêtes, garantissant que seules les actions déjà synchronisées sont candidates à la suppression.

Cette adaptation se fait via une méthode `replaceAll` qui parcourt l'ensemble des requêtes SQL et supprime ou conserve les conditions de synchronisation selon la configuration détectée automatiquement au démarrage :

```javascript
const patch = (query) =>
  withCommits ? query : query.replaceAll("AND commitId IS NOT NULL", "");
```

Le patching s'applique à toutes les occurrences de la condition dans les requêtes complexes, garantissant une cohérence totale entre les différentes sous-requêtes et évitant les incohérences de comportement.

#### Requête de nettoyage par date

La requête de nettoyage par date suit une structure similaire mais adapte les critères de sélection :

```sql
-- Select all actions to delete
SELECT rowid
FROM actions
LEFT JOIN (
  -- Select only the latest actions to collect
  SELECT max(rowid) AS max, goblinId
  FROM (
    -- Select all persist actions to collect
    SELECT rowid, goblin AS goblinId
    FROM actions
    WHERE rowid BETWEEN (
        -- Select the first action to remove
        SELECT rowid
        FROM actions
        WHERE goblin = goblinId
          AND type = 'persist'
          AND commitId IS NOT NULL
        ORDER BY rowid ASC
        LIMIT 1
      ) AND (
        -- Select the X'th older action to remove (we keep at least the latest actions)
        SELECT rowid
        FROM (
          SELECT rowid
          FROM actions
          WHERE goblin = goblinId
            AND type = 'persist'
            AND commitId IS NOT NULL
            AND timestamp < $datetime -- PARAMETER
          UNION ALL
          SELECT NULL as rowid
          ORDER BY rowid DESC
          LIMIT 2
        )
        ORDER BY rowid ASC
        LIMIT 1
      )
      AND type = 'persist'
      AND commitId IS NOT NULL
    ORDER BY goblin, rowid ASC
  )
  GROUP BY goblinId
) AS removeList
WHERE actions.goblin = removeList.goblinId
  AND actions.rowid <= removeList.max -- Here max is in the collectable list
```

La différence principale réside dans l'ajout de la condition temporelle `AND timestamp < $datetime` et l'utilisation de seulement 2 valeurs nulles de protection au lieu de 100, reflétant la stratégie de conservation minimale de 2 actions persist par goblin.

La condition finale utilise `<=` au lieu de `<`, incluant l'action de référence dans la suppression, ce qui est cohérent avec l'objectif de supprimer toutes les actions antérieures à une date donnée.

Le SoulSweeper constitue ainsi un composant essentiel pour maintenir les performances et la taille des bases de données Cryo dans des environnements de production à long terme, tout en préservant l'intégrité des données et la cohérence de l'historique des actions à travers des stratégies de nettoyage sophistiquées et adaptatives.

---

_Ce document a été mis à jour pour refléter l'implémentation actuelle du SoulSweeper._