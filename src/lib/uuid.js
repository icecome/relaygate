'use strict';
const crypto = require('crypto');

function uuidV4() {
  return crypto.randomUUID();
}

module.exports = { v4: uuidV4 };
