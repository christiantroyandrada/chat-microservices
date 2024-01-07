const mongoose = require('mongoose');

mongoose.Promise = global.Promise;

module.exports = async (dbOptions = {}) => {
  const {
    host = 'localhost',
    port = '27017',
    database = 'record',
  } = dbOptions;

  const options = {};

  const uri = `mongodb://${host}/${database}`;

  try {
    await mongoose.connect(uri, options);
    console.log('Connected to database ' + database);
  } catch (err) {
    console.error('Database Connection Failed',err);
  }
};