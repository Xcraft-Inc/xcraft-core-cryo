# Support du PRQL

L'idée est d'ajouter le support du PRQL pour simplifier les requêtes dans l'action store.

Voici un exemple :

```prql
prql target:sql.sqlite
# Ajoute quelques helpers pour l'extraction des propriétés
let extract = p -> s"JSON_EXTRACT(action,{p})"

let makePath = p -> f"$.payload.state.{p}"

let P = p -> (extract (makePath p))


# Déclare une table des tâches
let tasks = (
from lastPersistedActions
derive {
  actor = s"substr(goblin, 1, instr(goblin,'-')-1)",
  name = P "name",
  caseId = P "caseId"
}
filter actor == "task"
)


# Déclare une table des cas
let cases = (
from lastPersistedActions
derive {
  actor = s"substr(goblin, 1, instr(goblin,'-')-1)",
  reference = P "reference"
}
filter actor == "case"
)


# croise les deux tables
from t=tasks
join c=cases (==caseId)
derive {
  taskName = t.name,
  caseRef = c.reference
}


```