export const types = /* GraphQL */ `
  extend type Query {
    viewer: User
    user(id: String!): User
  }

  extend type Mutation {
    sendVerificationEmail(email: String!): Boolean
    registerUser(email: String!, userName: String!, displayName: String!, code: String): User
    toggleFollow(id: String): User!
    importArticles(platform: String, token: String): [Article]
    toggleNotificationSetting(type: String): NotificationSetting
    clearReadHistory: Boolean
    clearSearchHistory: Boolean
  }

  type User {
    id: String!
    # Get article for this user
    article(id: String!): Article!
    # Get other user info for this user
    user(id: String!): User!
    info: UserInfo!
    settings: UserSettings!
    # Personalized recommendations
    recommnedation: Recommendation!
    # Current user has followed this user
    hasFollowed: Boolean!
    # Articles written by this user
    articles(first: Int, after: Int): [Article]
    # drafts(first: Int, after: Int): [Draft]
    # audioDrafts(first: Int, after: Int): [AudioDraft]
    # Comments posted by this user
    comments(first: Int, after: Int): [Comment]
    # comments that citated this user's article
    citations(first: Int, after: Int): [Comment]
    subscriptions(first: Int, after: Int): [Article]
    activity: UserActivity!
    # Followers of this user
    followers: [User]
    # Users that this user follows
    follows: [User]
    status: UserStatus!
  }

  type UserInfo {
    # Unique user name
    userName: String!
    # Display name on profile
    displayName: String!
    # User desciption
    description: String!
    # URL for avatar
    avatar: String!
    email: String!
    mobile: String!
    # Use 500 for now, adaptive in the future
    readSpeed: Int!
  }

  type UserSettings {
    # User language setting
    language: UserLanguage!
    # Thrid party accounts binded for the user
    thirdPartyAccounts: [ThirdPartyAccount]
    # Notification settings
    notification: NotificationSetting!
  }

  type Recommendation {
    hottest(first: Int, after: Int): [Article]!
    # In case you missed it
    icymi(first: Int, after: Int): [Article]!
    authors (first: Int, after: Int): [User]!
  }

  type UserActivity {
    history(first: Int, after: Int): [Article] 
    recentSearches(first: Int, after: Int): [String]
  }

  type UserStatus {
    gravity: Int
    # Total MAT left in wallet
    MAT: Int!
    # Number of articles published by user
    articleCount: Int!
    # Number of views on articles
    viewCount: Int!
    draftCount: Int!
    # Number of comments posted by user
    commentCount: Int!
    citationCount: Int!
    subscriptionCount: Int!
    # Number of user that this user follows
    followCount: Int!
    # Number of user that follows this user
    followerCount: Int!
  }

  type NotificationSetting {
    mention: Boolean!
    folow: Boolean!
    comment: Boolean!
    appreciation: Boolean!
    subscribe: Boolean!
    commentOnSubscribed: Boolean!
    downstream: Boolean!
    commentPinned: Boolean!
    commentVoted: Boolean!
    walletUpdate: Boolean!
    officialNotice: Boolean!
    reportResult: Boolean!
  }

  enum UserLanguage {
    en
    zh_hans
    zh_hant
  }
  enum ThirdPartyAccount {
    facebook
    wechat
    google
  }
`
