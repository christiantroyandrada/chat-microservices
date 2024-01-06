const mongoose = require('mongoose');

mongoose.Promise = global.Promise;

module.exports = async (dbOptions = {}) => {
  const {
    host = 'localhost',
    // port = process.env.PORT,
    database = process.env.DB_DATABASE,
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