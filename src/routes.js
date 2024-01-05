const koaBody = require('koa-body');
const Router = require('koa-better-router');

module.exports = () => {
  let router = Router({prefix: '/api'}).loadMethods();
  // Retrieve all records
  router.get('/records', async req => {
    console.log('Retrieving all records');
    req.body = [];
  });

  //Find specific record
  router.get('/records/:id', async req => {
    const id = req.params.id;
    console.log(`Retrieving record with id ${id}`);
    req.body = {};
  });

  //Create a new record
  router.post('/records', koaBody(), async req => {
    const values = req.request.body;
    console.log(`Creating record with values ${JSON.stringify(values)}`);
    req.body = {};
  });

  //Update existing record
  router.put('/records/:id', koaBody(), async req => {
    const id = req.params.id;
    const values = req.request.body;
    console.log(`Updating record ${id} with values ${JSON.stringify(value)}`)
    req.status = 200;
  })

  //Delete a record
  router.delete('/records/:id', async req => {
    const id = ctx.params.id;
    console.log(`deleting record ${id}`);
    req.status = 200;
  });

  return router.middleware();
}