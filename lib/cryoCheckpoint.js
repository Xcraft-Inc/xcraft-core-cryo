// @ts-check
const {Elf} = require('xcraft-core-goblin');
const {string} = require('xcraft-core-stones');
const {capitalize} = require('xcraft-core-utils/lib/string.js');

class CryoCheckpointShape {
  id = string;
}

class CryoCheckpointState extends Elf.Sculpt(CryoCheckpointShape) {}

function createCheckpoint(db) {
  const className = capitalize(db);

  const CryoCheckpointLogic = class extends Elf.Archetype {
    static db = db;
    state = new CryoCheckpointState();

    create(id) {
      const {state} = this;
      state.id = id;
    }
  };

  Object.defineProperty(CryoCheckpointLogic, 'name', {
    value: `${className}CryoCheckpointLogic`,
  });

  const CryoCheckpoint = class extends Elf {
    logic = Elf.getLogic(CryoCheckpointLogic);
    state = new CryoCheckpointState();

    async create(id, desktopId) {
      await this.logic.create(id);
      await this.persist();
      return this;
    }

    delete() {}
  };

  Object.defineProperty(CryoCheckpoint, 'name', {
    value: `${className}CryoCheckpoint`,
  });

  return {CryoCheckpoint, CryoCheckpointLogic};
}

exports.xcraftCommands = (db) => {
  const {CryoCheckpoint, CryoCheckpointLogic} = createCheckpoint(db);
  return Elf.birth(CryoCheckpoint, CryoCheckpointLogic)();
};

/* const xBus = require('xcraft-core-bus');
 * await xBus.loadModule(this.quest.resp, ['cryoCheckpoint.js'], __dirname, {}, db);
 */
