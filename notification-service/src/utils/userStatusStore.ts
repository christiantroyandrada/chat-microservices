export class UserStatusStore {
  private static instance: UserStatusStore
  private userStatus: Record<string, boolean>

  constructor() {
    this.userStatus = {}
  }

  public static getInstance(): UserStatusStore {
    if (!UserStatusStore.instance) {
      UserStatusStore.instance = new UserStatusStore()
    }
    return UserStatusStore.instance
  }

  setUserOnline(userId: string) {
    this.userStatus[userId] = true
  }

  setUserOffline(userId: string) {
    this.userStatus[userId] = false
  }

  isUserOnline(userId: string): boolean {
    return !!this.userStatus[userId]
  }
}