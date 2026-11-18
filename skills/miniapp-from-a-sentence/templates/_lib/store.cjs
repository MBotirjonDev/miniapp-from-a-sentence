'use strict';
// A tiny JSON-file store, zero dependencies. Every save writes a temp file and renames it over the
// old one, so a crash mid-write never leaves a half-written file. Fine for one small shop (hundreds
// of orders a day); move to a real database when you outgrow it or run more than one server process.
const fs = require('fs');
const path = require('path');

/**
 * @param {string} file          path to the JSON file (its folder is created if missing)
 * @param {() => object} seed    returns the initial data when the file does not exist yet
 */
function createStore(file, seed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data;
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8')); // a corrupt file should stop the server, not be overwritten
  } else {
    data = seed();
    write();
  }
  function write() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  return { get data() { return data; }, save: write, file };
}

module.exports = { createStore };
