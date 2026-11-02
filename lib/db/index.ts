export {
    query,
    pool,
    getClient,
    initDatabase,
    ensureTablesExist,
    getOrCreateModelPrices,
    updateModelPrice,
} from './client'

export type { ModelPrice, UserUsageRecord } from './client'

export {
    getUsers,
    getOrCreateUser,
    updateUserBalance,
    deleteUser,
    ensureUserTableExists,
} from './users'

export type { User } from './users'
