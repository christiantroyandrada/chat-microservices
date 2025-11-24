import { UserStatusStore } from '../../src/utils/userStatusStore'

describe('UserStatusStore singleton', () => {
  beforeEach(() => {
    // Reset internal singleton by deleting private instance (hack for tests)
    ;(UserStatusStore as any).instance = undefined
  })

  test('getInstance returns same instance and toggles online status', () => {
    const s1 = UserStatusStore.getInstance()
    const s2 = UserStatusStore.getInstance()
    expect(s1).toBe(s2)

    s1.setUserOnline('u1')
    expect(s1.isUserOnline('u1')).toBe(true)

    s1.setUserOffline('u1')
    expect(s1.isUserOnline('u1')).toBe(false)
  })
})
