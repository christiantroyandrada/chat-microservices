import mongoose, { Document, Schema } from 'mongoose'
import validator from 'validator'

export interface IUser extends Document {
  name: string
  email: string
  password: string
  createdAt: Date
  updatedAt: Date
}

const UserSchema: Schema = new Schema({
  name: {
    type: String,
    required: [ true , 'Name is required' ],
    trim: true,
    minLength: 3,
  },
  email: {
    type: String,
    required: [ true , 'Email is required' ],
    unique: true,
    trim: true,
    lowercase: true,
    validate: [validator.isEmail, 'Invalid email address'],
  },
  password: {
    type: String,
    required: [ true , 'Password is required' ],
    trim: false,
    minLength: 8,
  },
}, {
  timestamps: true,
})

const User = mongoose.model<IUser>('User', UserSchema)

export default User