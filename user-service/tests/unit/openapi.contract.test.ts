import spec from '../../src/openapi';

type Method = 'get' | 'post';

function responseRef(path: string, method: Method, status = '200'): string | undefined {
  const operation = (spec.paths as Record<string, Record<string, any>>)[path]?.[method];
  return operation?.responses?.[status]?.content?.['application/json']?.schema?.$ref;
}

describe('user-service OpenAPI contract', () => {
  it('wraps runtime values in the actual API envelope', () => {
    expect(responseRef('/register', 'post')).toBe('#/components/schemas/UserResponse');
    expect(responseRef('/login', 'post')).toBe('#/components/schemas/StatusResponse');
    expect(responseRef('/me', 'get')).toBe('#/components/schemas/UserResponse');
    expect(responseRef('/search', 'get')).toBe('#/components/schemas/UserListResponse');
  });

  it('names authentication request bodies for deterministic generation', () => {
    const paths = spec.paths as Record<string, Record<string, any>>;
    expect(paths['/register'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/RegisterRequest'
    );
    expect(paths['/login'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/LoginRequest'
    );
  });

  it('models publish and consume prekey payloads separately', () => {
    const schemas = spec.components.schemas as Record<string, any>;
    expect(schemas.PublishPrekeyRequest.required).toEqual(['deviceId', 'bundle']);
    expect(schemas.PrekeyBundle.required).toEqual([
      'registrationId', 'identityKey', 'signedPreKey', 'preKeys'
    ]);
    expect(schemas.PrekeyBundle.properties.preKeys.type).toBe('array');
    expect(responseRef('/prekeys/{userId}', 'get')).toBe(
      '#/components/schemas/ConsumedPrekeyResponse'
    );
  });

  it('requires the distinct runtime user shapes', () => {
    const schemas = spec.components.schemas as Record<string, any>;
    expect(schemas.User.required).toEqual([
      'id', 'username', 'email'
    ]);
    expect(schemas.SearchUser.required).toEqual(['_id', 'username', 'email']);
    expect(schemas.UserListResponse.required).toEqual(['status', 'data']);
    expect(schemas.UserListResponse.properties.data.items.$ref).toBe(
      '#/components/schemas/SearchUser'
    );
  });

  it('requires the device id used by the Signal backup lookup', () => {
    const paths = spec.paths as Record<string, Record<string, any>>;
    expect(paths['/signal-keys'].get.parameters).toEqual([
      {
        name: 'deviceId',
        in: 'query',
        required: true,
        schema: { type: 'string' },
      },
    ]);
  });
});
