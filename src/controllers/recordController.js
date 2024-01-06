const Record = require('../models/Record');

exports.get = async ctx => {
  ctx.body = await Record.find();
};

exports.view= async ctx => {
  const id = ctx.params.id;
  const record = await Record.findById(id);

  if (!record) {
    ctx.throw(404, 'Record not found!');
  }
  ctx.body = record;
};

exports.create= async ctx => {
  const value = ctx.request.body;
  const newRecord = await Record.create(value);

  if (!newRecord || !newRecord._id) {
    ctx.throw(500, 'Something went wrong!');
  }
  ctx.body = newRecord;
};

exports.update = async ctx => {
  const id = ctx.params.id;
  const value = ctx.request.body;

  const foundRecord = await Record.findById(id);
  
  if (!foundRecord || !foundRecord._id) {
    ctx.throw(404, 'Record Not Found!');
  }

  const updated = await Record.findByIdAndUpdate(id, value, { new: true });
  
  ctx.body = updated;
};

exports.delete = async ctx => {
  const id = ctx.params.id;
  const record = await Record.findById(id);

  if (!record) {
    ctx.throw(404, 'Record Not Found!');
  }

  const deletedRecord = await Record.findByIdAndRemove(id);

  if(!deletedRecord) {
    ctx.throw(500, 'Something Went Wrong!');
  }

  ctx.body = deletedRecord;
};