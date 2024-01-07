require('dotenv').config();
const Koa = require('koa');
const routes = require('./src/routes');
const app = new Koa();
const connectToDb = require('./src/db-connect');
const PORT = process.env.PORT || 8080;

connectToDb({
  host: process.env.DB_HOST,
  port: process.env.PORT,
  database: process.env.DB_DATABASE,
});

//load the routes
app.use(routes())

//init the server
const server = app.listen(PORT, () => {
  console.log(`listening on port ${PORT}`);
});