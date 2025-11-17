// Consolidated test fixtures for MessageController tests

export const mockUser = {
	_id: 'user-123',
	email: 'test@example.com',
	name: 'Test User',
	password: 'hashedpassword',
	createdAt: new Date('2025-11-17T09:00:00Z'),
	updatedAt: new Date('2025-11-17T09:00:00Z')
}

export const mockReceiver = {
	_id: 'user-456',
	email: 'receiver@example.com',
	name: 'Receiver User'
}

export const mockMessage = {
	id: 'msg-123',
	senderId: mockUser._id,
	receiverId: mockReceiver._id,
	message: JSON.stringify({
		__encrypted: true,
		type: 3,
		body: 'base64EncodedEncryptedMessage=='
	}),
	isEncrypted: true,
	status: 'not_delivered',
	createdAt: new Date('2025-11-17T10:00:00Z'),
	updatedAt: new Date('2025-11-17T10:00:00Z')
}

export const mockMessages = [
	mockMessage,
	{
		...mockMessage,
		id: 'msg-124',
		message: JSON.stringify({
			__encrypted: true,
			type: 3,
			body: 'anotherBase64EncodedMessage=='
		}),
		createdAt: new Date('2025-11-17T10:01:00Z'),
		updatedAt: new Date('2025-11-17T10:01:00Z')
	}
]

export const mockConversation = {
	userId: mockReceiver._id,
	username: mockReceiver.name,
	lastMessage: '[Encrypted message]',
	lastMessageTime: new Date('2025-11-17T10:00:00Z'),
	unreadCount: 2
}
