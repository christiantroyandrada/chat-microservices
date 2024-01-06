const koaBody = require('koa-body');
const Router = require('koa-better-router');
const recordsController = require('./controllers/recordController');

module.exports = () => {
  let router = Router({prefix: '/api'}).loadMethods();
  // Retrieve all records
  router.get('/records', recordsController.get);

  //Find specific record
  router.get('/records/:id', recordsController.view);

  //Create a new record
  router.post('/records', koaBody(), recordsController.create);

  //Update existing record
  router.put('/records/:id', koaBody(), recordsController.update);

  //Delete a record
  router.delete('/records/:id', recordsController.delete);

  return router.middleware();
}