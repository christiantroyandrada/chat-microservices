export class UserStatusStore {
  private static instance: UserStatusStore
  private userStatusTypes: Record<string, boolean>

  private constructor () {
    this.userStatusTypes = {}
  }

  public static getInstance (): UserStatusStore {
    if (!UserStatusStore.instance) {
      UserStatusStore.instance = new UserStatusStore()
    }
    return UserStatusStore.instance
  }

  setUserOnline (userId: string) {
    this.userStatusTypes[userId] = true
  }

  setUserOffline (userId: string) {
    this.userStatusTypes[userId] = false
  }

  isUserOnline (userId: string): boolean {
    return !!this.userStatusTypes[userId]
  }
}