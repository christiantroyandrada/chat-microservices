export class UserStatusStore {
  private static instance: UserStatusStore
  private onlineUsers: Set<string>

  private constructor () {
    this.onlineUsers = new Set()
  }

  public static getInstance (): UserStatusStore {
    if (!UserStatusStore.instance) {
      UserStatusStore.instance = new UserStatusStore()
    }
    return UserStatusStore.instance
  }

  setUserOnline (userId: string) {
    this.onlineUsers.add(userId)
  }

  setUserOffline (userId: string) {
    // Delete instead of storing false — prevents unbounded memory growth
    this.onlineUsers.delete(userId)
  }

  isUserOnline (userId: string): boolean {
    return this.onlineUsers.has(userId)
  }
}