import prisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';
import type { CreateEmailInput, UpdateEmailInput, ListEmailInput, ImportEmailInput, GenerateAliasInput } from './email.schema.js';

const HOTMAIL_ALIAS_DOMAINS = new Set([
    'hotmail.com', 'outlook.com', 'live.com',
    'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
    'hotmail.it', 'hotmail.es', 'hotmail.co.jp',
    'outlook.co.uk', 'outlook.fr', 'outlook.de',
    'msn.com', 'windowslive.com',
]);

const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AliasRelationSummary {
    type: 'PRIMARY' | 'ALIAS' | 'NORMAL';
    primaryEmail?: string;
    aliasCount?: number;
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function getPrimaryEmailFromAlias(email: string): string | null {
    const normalizedEmail = normalizeEmail(email);
    const atIndex = normalizedEmail.indexOf('@');
    if (atIndex <= 0) {
        return null;
    }

    const localPart = normalizedEmail.slice(0, atIndex);
    const domain = normalizedEmail.slice(atIndex + 1);
    const plusIndex = localPart.indexOf('+');
    if (plusIndex <= 0 || !domain) {
        return null;
    }

    return `${localPart.slice(0, plusIndex)}@${domain}`;
}

function buildAliasRelationMap(accounts: Array<{ id: number; email: string }>): Map<number, AliasRelationSummary> {
    const emailSet = new Set(accounts.map((item) => normalizeEmail(item.email)));
    const aliasCountMap = new Map<string, number>();
    const relationMap = new Map<number, AliasRelationSummary>();

    accounts.forEach((item) => {
        const primaryEmail = getPrimaryEmailFromAlias(item.email);
        if (primaryEmail && emailSet.has(primaryEmail)) {
            aliasCountMap.set(primaryEmail, (aliasCountMap.get(primaryEmail) ?? 0) + 1);
            relationMap.set(item.id, {
                type: 'ALIAS',
                primaryEmail,
            });
            return;
        }

        relationMap.set(item.id, { type: 'NORMAL' });
    });

    accounts.forEach((item) => {
        const normalizedEmail = normalizeEmail(item.email);
        const aliasCount = aliasCountMap.get(normalizedEmail) ?? 0;
        if (aliasCount > 0) {
            relationMap.set(item.id, {
                type: 'PRIMARY',
                aliasCount,
            });
        }
    });

    return relationMap;
}

function isSupportedAliasEmail(email: string): boolean {
    const normalizedEmail = normalizeEmail(email);
    const atIndex = normalizedEmail.lastIndexOf('@');
    if (atIndex <= 0) {
        return false;
    }

    const domain = normalizedEmail.slice(atIndex + 1);
    return HOTMAIL_ALIAS_DOMAINS.has(domain);
}

function hasPlusAlias(email: string): boolean {
    const localPart = email.trim().split('@', 1)[0] || '';
    return localPart.includes('+');
}

function looksLikeClientId(value: string | undefined): boolean {
    if (!value) {
        return false;
    }

    return UUID_LIKE_REGEX.test(value.trim());
}

export const emailService = {
    /**
     * 获取邮箱列表
     */
    async list(input: ListEmailInput) {
        const { page, pageSize, status, keyword, groupId, groupName } = input;
        const skip = (page - 1) * pageSize;

        const where: Prisma.EmailAccountWhereInput = {};
        if (status) where.status = status;
        if (keyword) {
            where.email = { contains: keyword };
        }
        if (groupId) {
            where.groupId = groupId;
        } else if (groupName) {
            where.group = { name: groupName };
        }

        const aliasRelationWhere: Prisma.EmailAccountWhereInput = {};
        if (groupId) {
            aliasRelationWhere.groupId = groupId;
        } else if (groupName) {
            aliasRelationWhere.group = { name: groupName };
        }

        const [list, total, relationSourceAccounts] = await Promise.all([
            prisma.emailAccount.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    clientId: true,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                tokenRefreshFailedAt: true,
                tokenRefreshFailureReason: true,
                errorMessage: true,
                createdAt: true,
            },
                skip,
                take: pageSize,
                orderBy: { id: 'desc' },
            }),
            prisma.emailAccount.count({ where }),
            prisma.emailAccount.findMany({
                where: aliasRelationWhere,
                select: {
                    id: true,
                    email: true,
                },
            }),
        ]);

        // 别名关联按“同一分组范围内的完整邮箱集合”计算，不再受分页、关键字、状态筛选影响，
        // 避免主邮箱或别名被临时筛出列表后，前端出现关联忽有忽无的问题。
        const aliasRelationMap = buildAliasRelationMap(relationSourceAccounts);
        const enrichedList = list.map((item: (typeof list)[number]) => ({
            ...item,
            aliasRelation: aliasRelationMap.get(item.id) ?? { type: 'NORMAL' as const },
        }));

        return { list: enrichedList, total, page, pageSize };
    },

    /**
     * 获取邮箱详情
     */
    async getById(id: number, includeSecrets = false) {
        const email = await prisma.emailAccount.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                clientId: true,
                password: !!includeSecrets,
                refreshToken: !!includeSecrets,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                tokenRefreshFailedAt: true,
                tokenRefreshFailureReason: true,
                errorMessage: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!email) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        // 解密敏感信息
        if (includeSecrets) {
            return {
                ...email,
                refreshToken: email.refreshToken ? decrypt(email.refreshToken) : email.refreshToken,
                password: email.password ? decrypt(email.password) : email.password,
            };
        }

        return email;
    },

    /**
     * 根据邮箱地址获取（用于外部 API）
     */
    async getByEmail(emailAddress: string) {
        const email = await prisma.emailAccount.findUnique({
            where: { email: emailAddress },
            select: {
                id: true,
                email: true,
                clientId: true,
                refreshToken: true,
                password: true,
                status: true,
                groupId: true,
                group: {
                    select: {
                        fetchStrategy: true,
                    },
                },
            },
        });

        if (!email) {
            return null;
        }

        // 解密
        return {
            ...email,
            refreshToken: decrypt(email.refreshToken),
            password: email.password ? decrypt(email.password) : undefined,
            fetchStrategy: email.group?.fetchStrategy || 'GRAPH_FIRST',
        };
    },

    /**
     * 创建邮箱账户
     */
    async create(input: CreateEmailInput) {
        const { email, clientId, refreshToken, password, groupId } = input;

        const exists = await prisma.emailAccount.findUnique({ where: { email } });
        if (exists) {
            throw new AppError('DUPLICATE_EMAIL', 'Email already exists', 400);
        }

        const encryptedToken = encrypt(refreshToken);
        const encryptedPassword = password ? encrypt(password) : null;

        const account = await prisma.emailAccount.create({
            data: {
                email,
                clientId,
                refreshToken: encryptedToken,
                password: encryptedPassword,
                groupId: groupId || null,
            },
            select: {
                id: true,
                email: true,
                clientId: true,
                status: true,
                groupId: true,
                createdAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱账户
     */
    async update(id: number, input: UpdateEmailInput) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        const { refreshToken, password, ...rest } = input;
        const updateData: Prisma.EmailAccountUpdateInput = { ...rest };

        // 仅在前端显式传入时更新敏感字段，避免编辑其他字段时误清空原有凭据。
        if (refreshToken !== undefined) {
            updateData.refreshToken = encrypt(refreshToken);
        }
        if (password !== undefined) {
            updateData.password = encrypt(password);
        }

        const account = await prisma.emailAccount.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                email: true,
                clientId: true,
                status: true,
                updatedAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱状态
     */
    async updateStatus(id: number, status: 'ACTIVE' | 'ERROR' | 'DISABLED', errorMessage?: string | null) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                status,
                errorMessage: errorMessage || null,
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 仅更新时间，不改动邮箱状态
     */
    async touchLastCheckAt(id: number) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 删除邮箱账户
     */
    async delete(id: number) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        await prisma.emailAccount.delete({ where: { id } });
        return { success: true };
    },

    /**
     * 批量删除
     */
    async batchDelete(ids: number[]) {
        await prisma.emailAccount.deleteMany({
            where: { id: { in: ids } },
        });
        return { deleted: ids.length };
    },

    /**
     * 批量导入
     */
    async import(input: ImportEmailInput) {
        const { content, separator, groupId } = input;
        const lines = content.split('\n').filter((line: string) => line.trim());

        if (groupId !== undefined) {
            const group = await prisma.emailGroup.findUnique({ where: { id: groupId } });
            if (!group) {
                throw new AppError('GROUP_NOT_FOUND', 'Email group not found', 404);
            }
        }

        let success = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const line of lines) {
            try {
                const parts = line.trim().split(separator);
                if (parts.length < 3) {
                    throw new Error('Invalid format');
                }

                let email, clientId, refreshToken, password;

                // 尝试猜测格式
                // 1. email----password----clientId----refreshToken (4列)
                // 2. email----clientId----refreshToken (3列)
                // 3. email----clientId----uuid----info----refreshToken (5列)

                if (parts.length >= 5) {
                    email = parts[0];
                    refreshToken = parts[parts.length - 1];

                    // 5 列历史数据存在两种来源：
                    // 1) email----clientId----uuid----info----refreshToken
                    // 2) email----password----clientId----info----refreshToken
                    // 这里优先通过 clientId 的 UUID 特征做兼容判断，避免把 clientId 错读成密码。
                    if (looksLikeClientId(parts[1]) && !looksLikeClientId(parts[2])) {
                        clientId = parts[1];
                    } else if (!looksLikeClientId(parts[1]) && looksLikeClientId(parts[2])) {
                        password = parts[1] || undefined;
                        clientId = parts[2];
                    } else {
                        // 默认回退到历史老格式，优先保证导入后的 clientId 正确。
                        clientId = parts[1];
                    }
                } else if (parts.length === 4) {
                    // email----password----clientId----refreshToken
                    email = parts[0];
                    password = parts[1];
                    clientId = parts[2];
                    refreshToken = parts[3];
                } else {
                    // email----clientId----refreshToken
                    email = parts[0];
                    clientId = parts[1];
                    refreshToken = parts[2];
                }

                if (!email || !clientId || !refreshToken) {
                    throw new Error('Missing required fields');
                }

                const data: Prisma.EmailAccountUncheckedUpdateInput = {
                    clientId,
                    refreshToken: encrypt(refreshToken),
                    status: 'ACTIVE',
                    tokenRefreshFailedAt: null,
                    tokenRefreshFailureReason: null,
                };
                if (password) data.password = encrypt(password);
                if (groupId !== undefined) data.groupId = groupId;

                // 检查是否存在
                const exists = await prisma.emailAccount.findUnique({ where: { email } });
                if (exists) {
                    // 更新
                    await prisma.emailAccount.update({
                        where: { email },
                        data,
                    });
                } else {
                    // 创建
                    const createData: Prisma.EmailAccountUncheckedCreateInput = {
                        email,
                        clientId,
                        refreshToken: encrypt(refreshToken),
                        status: 'ACTIVE',
                        tokenRefreshFailedAt: null,
                        tokenRefreshFailureReason: null,
                    };
                    if (password) {
                        createData.password = encrypt(password);
                    }
                    if (groupId !== undefined) {
                        createData.groupId = groupId;
                    }
                    await prisma.emailAccount.create({
                        data: createData,
                    });
                }
                success++;
            } catch (err) {
                failed++;
                errors.push(`Line "${line.substring(0, 30)}...": ${(err as Error).message}`);
            }
        }

        return { success, failed, errors };
    },

    /**
     * 导出
     */
    async export(ids?: number[], separator = '----', groupId?: number) {
        const where: Prisma.EmailAccountWhereInput = {};
        if (ids?.length) {
            where.id = { in: ids };
        }
        if (groupId !== undefined) {
            where.groupId = groupId;
        }

        const accounts = await prisma.emailAccount.findMany({
            where,
            select: {
                email: true,
                password: true,
                clientId: true,
                refreshToken: true,
            },
        });

        const lines = accounts.map((acc: { email: string; password: string | null; clientId: string; refreshToken: string }) => {
            const password = acc.password ? decrypt(acc.password) : '';
            const token = decrypt(acc.refreshToken);
            return `${acc.email}${separator}${password}${separator}${acc.clientId}${separator}${token}`;
        });

        return lines.join('\n');
    },

    /**
     * 批量生成 Hotmail/Outlook Plus 别名文本
     */
    async generateAliases(input: GenerateAliasInput) {
        const {
            ids,
            groupId,
            status,
            keyword,
            aliasCount,
            prefix,
            separator,
        } = input;

        const where: Prisma.EmailAccountWhereInput = {};
        if (ids?.length) {
            where.id = { in: ids };
        }
        if (groupId !== undefined) {
            where.groupId = groupId;
        }
        if (status) {
            where.status = status;
        }
        if (keyword) {
            where.email = { contains: keyword };
        }

        const accounts = await prisma.emailAccount.findMany({
            where,
            select: {
                id: true,
                email: true,
                password: true,
                clientId: true,
                refreshToken: true,
            },
            orderBy: { id: 'asc' },
        });

        const contentLines: string[] = [];
        let eligibleCount = 0;
        let skippedPlusAliasCount = 0;
        let skippedUnsupportedDomainCount = 0;

        for (const account of accounts) {
            if (!isSupportedAliasEmail(account.email)) {
                skippedUnsupportedDomainCount += 1;
                continue;
            }

            if (hasPlusAlias(account.email)) {
                skippedPlusAliasCount += 1;
                continue;
            }

            eligibleCount += 1;
            const [localPart, domain] = account.email.split('@');
            const password = account.password ? decrypt(account.password) : '';
            const refreshToken = decrypt(account.refreshToken);

            // 仅生成别名行，不包含原邮箱，保持与参考脚本一致。
            for (let index = 1; index <= aliasCount; index += 1) {
                const aliasEmail = `${localPart}+${prefix}${index}@${domain}`;
                contentLines.push(`${aliasEmail}${separator}${password}${separator}${account.clientId}${separator}${refreshToken}`);
            }
        }

        return {
            content: contentLines.join('\n'),
            stats: {
                sourceCount: accounts.length,
                eligibleCount,
                aliasCountPerEmail: aliasCount,
                generatedCount: contentLines.length,
                skippedPlusAliasCount,
                skippedUnsupportedDomainCount,
            },
        };
    },

    /**
     * 获取统计
     */
    async getStats() {
        const [total, active, error] = await Promise.all([
            prisma.emailAccount.count(),
            prisma.emailAccount.count({ where: { status: 'ACTIVE' } }),
            prisma.emailAccount.count({ where: { status: 'ERROR' } }),
        ]);

        return { total, active, error };
    },
};
