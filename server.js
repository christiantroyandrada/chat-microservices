const Koa = require('koa');
const routes = require('./src/routes');;
const app = new Koa();

//load the routes
app.use(routes())

//init the server
const server = app.listen(8080, () => {
  console.log('listening on port 8080');
});