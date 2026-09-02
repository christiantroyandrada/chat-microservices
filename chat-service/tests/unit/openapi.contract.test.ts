import spec from '../../src/openapi'

function responseRef(path: string, method: 'get' | 'post' | 'put'): string | undefined {
  const operation = (spec.paths as Record<string, Record<string, any>>)[path]?.[method]
  return operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref
}

function requestRef(path: string, method: 'post'): string | undefined {
  const operation = (spec.paths as Record<string, Record<string, any>>)[path]?.[method]
  return operation?.requestBody?.content?.['application/json']?.schema?.$ref
}

describe('chat-service OpenAPI contract', () => {
  it('uses the runtime message status values', () => {
    const message = (spec.components.schemas as Record<string, any>).Message
    expect(message.properties.status.enum).toEqual(['NotDelivered', 'Delivered', 'Seen'])
    expect(message.required).toEqual([
      'id', 'senderId', 'receiverId', 'message', 'isEncrypted', 'status', 'createdAt', 'updatedAt'
    ])
  })

  it('models each successful response envelope exactly once', () => {
    expect(responseRef('/send', 'post')).toBe('#/components/schemas/MessageResponse')
    expect(responseRef('/get/{receiverId}', 'get')).toBe(
      '#/components/schemas/MessagesPageResponse'
    )
    expect(responseRef('/conversations', 'get')).toBe(
      '#/components/schemas/ConversationListResponse'
    )
    expect(responseRef('/messages/read/{senderId}', 'put')).toBe(
      '#/components/schemas/MarkReadResponse'
    )
    expect((spec.components.schemas as Record<string, any>).MessagesPageResponse.properties.pagination.$ref).toBe(
      '#/components/schemas/Pagination'
    )
  })

  it('uses the canonical send message request schema', () => {
    expect(requestRef('/send', 'post')).toBe('#/components/schemas/SendMessageRequest')

    const request = (spec.components.schemas as Record<string, any>).SendMessageRequest
    expect(request.required).toEqual(['receiverId', 'message'])
    expect(request.properties).toEqual({
      receiverId: { type: 'string', format: 'uuid' },
      message: {
        type: 'string',
        description: 'Signal-protocol encrypted envelope (JSON string, max 5000 chars)'
      }
    })
  })


  it('exposes stable operation identifiers and gateway metadata', () => {
    expect((spec as any)['x-service-id']).toBe('chat');
    expect((spec as any)['x-gateway-prefix']).toBe('/chat');
    const paths = spec.paths as Record<string, Record<string, any>>;
    expect(paths['/send'].post.operationId).toBe('chat.sendMessage');
    expect(paths['/send'].post['x-response-mode']).toBe('envelope');
    expect(paths['/get/{receiverId}'].get.operationId).toBe('chat.listMessages');
    expect(paths['/conversations'].get.operationId).toBe('chat.listConversations');
    expect(paths['/messages/read/{senderId}'].put.operationId).toBe('chat.markAsRead');
    expect(paths['/health'].get['x-response-mode']).toBe('raw');
    expect(paths['/metrics'].get['x-response-mode']).toBe('raw');
  });

  it('requires the exact published conversation fields and a numeric unread count', () => {
    const conversation = (spec.components.schemas as Record<string, any>).Conversation

    expect(conversation.required).toEqual(['id', 'name', 'avatar', 'lastMessage', 'unreadCount', 'lastMessageTime'])
    expect(conversation.properties.unreadCount).toEqual({ type: 'integer' })
  })

  it('declares the pagination rejection body alongside the successful page contract', () => {
    const operation = (spec.paths as Record<string, Record<string, any>>)['/get/{receiverId}'].get
    expect(operation['x-response-mode']).toBe('envelope')
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/MessagesPageResponse',
    })
    expect(operation.responses['400'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Error',
    })
  })
})
