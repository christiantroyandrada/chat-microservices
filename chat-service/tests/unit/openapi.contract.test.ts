import spec from '../../src/openapi'

function responseRef(path: string, method: 'get' | 'post' | 'put'): string | undefined {
  const operation = (spec.paths as Record<string, Record<string, any>>)[path]?.[method]
  return operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref
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
})
