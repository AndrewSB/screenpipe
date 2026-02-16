import { Env, UserTier, TierLimits, UsageResult, UsageStatus, TranscriptionUsageResult, TranscriptionTierLimits } from '../types';

const CLERK_ID_REGEX = /^user_[a-zA-Z0-9]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cache UUID → clerk_id mappings (lives for worker lifetime)
const clerkIdCache = new Map<string, string>();

/**
 * Resolve a userId to a clerk_id. user_credits table uses clerk_id as user_id.
 * If already a clerk_id, returns as-is. If UUID, looks up in users table.
 */
async function resolveClerkId(env: Env, userId: string): Promise<string | null> {
  if (!userId) return null;
  if (CLERK_ID_REGEX.test(userId)) return userId;

  // Check cache
  const cached = clerkIdCache.get(userId);
  if (cached) return cached;

  if (UUID_REGEX.test(userId)) {
    try {
      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/users?select=clerk_id&id=eq.${userId}&limit=1`,
        {
          headers: {
            apikey: env.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
          },
        }
      );
      if (!response.ok) return null;
      const rows = await response.json() as Array<{ clerk_id: string | null }>;
      if (rows.length > 0 && rows[0].clerk_id) {
        clerkIdCache.set(userId, rows[0].clerk_id);
        return rows[0].clerk_id;
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Try to deduct 1 credit from user's balance via Supabase RPC.
 * Returns remaining balance or -1 if insufficient/error.
 */
async function tryDeductCredit(env: Env, userId: string, reason: string): Promise<{ success: boolean; remaining: number }> {
  const clerkId = await resolveClerkId(env, userId);
  if (!clerkId) return { success: false, remaining: 0 };

  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/deduct_credits`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_user_id: clerkId,
        p_amount: 1,
        p_type: reason,
        p_description: `${reason} via ai gateway`,
        p_reference_id: `gw-${Date.now()}`,
      }),
    });

    if (!response.ok) {
      console.error('deduct_credits error:', await response.text());
      return { success: false, remaining: 0 };
    }

    const result = await response.json() as Array<{ success: boolean; new_balance: number; error_message: string | null }>;
    if (Array.isArray(result) && result.length > 0 && result[0].success) {
      return { success: true, remaining: result[0].new_balance };
    }
    return { success: false, remaining: 0 };
  } catch (error) {
    console.error('credit deduction failed:', error);
    return { success: false, remaining: 0 };
  }
}

/**
 * Get user's current credit balance without deducting.
 */
async function getCreditBalance(env: Env, userId: string): Promise<number> {
  const clerkId = await resolveClerkId(env, userId);
  if (!clerkId) return 0;

  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_credits?select=balance&user_id=eq.${encodeURIComponent(clerkId)}&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
      }
    );

    if (!response.ok) return 0;
    const rows = await response.json() as Array<{ balance: number }>;
    return rows.length > 0 ? rows[0].balance : 0;
  } catch {
    return 0;
  }
}

// IP-based abuse prevention limits (on top of device limits)
const IP_DAILY_LIMIT = 200; // Max queries per IP per day (catches device ID spoofing)

// Tier configuration - models and limits per tier
export const TIER_CONFIG: Record<UserTier, TierLimits> = {
  anonymous: {
    dailyQueries: 25,
    rpm: 15,
    allowedModels: [
      'claude-haiku-4-5',
      'gemini-3-flash',
      'gemini-2.5-flash',
    ],
  },
  logged_in: {
    dailyQueries: 50,
    rpm: 25,
    allowedModels: [
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'gpt-4o-mini',
      'gemini-3-flash',
      'gemini-2.5-flash',
      'gemini-3-pro',
    ],
  },
  subscribed: {
    dailyQueries: 200, // hard cap to control Vertex AI costs
    rpm: 60,
    allowedModels: ['*'], // all models
  },
};

// Schema is defined in migrations/0001_create_usage_table.sql
// Run: wrangler d1 execute screenpipe-usage --file=./migrations/0001_create_usage_table.sql

/**
 * Get today's date in UTC as ISO string (YYYY-MM-DD)
 */
function getTodayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get the reset time for the next day (midnight UTC)
 */
function getNextResetTime(): string {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

/**
 * Track a request and check if it's within limits
 * Also checks IP-based limits to prevent device ID spoofing abuse
 */
export async function trackUsage(
  env: Env,
  deviceId: string,
  tier: UserTier,
  userId?: string,
  ipAddress?: string
): Promise<UsageResult> {
  const today = getTodayUTC();
  const limits = TIER_CONFIG[tier];

  try {
    // IP-based abuse prevention (catches device ID spoofing)
    if (ipAddress && tier === 'anonymous') {
      const ipKey = `ip:${ipAddress}`;
      const ipUsage = await env.DB.prepare(
        'SELECT daily_count, last_reset FROM usage WHERE device_id = ?'
      ).bind(ipKey).first<{ daily_count: number; last_reset: string }>();

      if (ipUsage) {
        const ipCount = ipUsage.last_reset < today ? 0 : ipUsage.daily_count;
        if (ipCount >= IP_DAILY_LIMIT) {
          console.warn(`IP abuse detected: ${ipAddress} has ${ipCount} queries today`);
          return {
            used: ipCount,
            limit: IP_DAILY_LIMIT,
            remaining: 0,
            allowed: false,
            resetsAt: getNextResetTime(),
          };
        }
      }

      // Track IP usage (upsert)
      await env.DB.prepare(`
        INSERT INTO usage (device_id, daily_count, last_reset, tier)
        VALUES (?, 1, ?, 'ip_tracking')
        ON CONFLICT(device_id) DO UPDATE SET
          daily_count = CASE WHEN last_reset < ? THEN 1 ELSE daily_count + 1 END,
          last_reset = ?
      `).bind(ipKey, today, today, today).run();
    }

    // Try to get existing record
    const existing = await env.DB.prepare(
      'SELECT daily_count, last_reset FROM usage WHERE device_id = ?'
    ).bind(deviceId).first<{ daily_count: number; last_reset: string }>();

    let dailyCount = 0;

    if (existing) {
      // Check if we need to reset (new day)
      if (existing.last_reset < today) {
        // Reset count for new day
        await env.DB.prepare(
          'UPDATE usage SET daily_count = 1, last_reset = ?, tier = ?, user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE device_id = ?'
        ).bind(today, tier, userId || null, deviceId).run();
        dailyCount = 1;
      } else {
        // Check limit BEFORE incrementing — don't inflate counter on rejected requests
        if (existing.daily_count >= limits.dailyQueries) {
          // Daily free quota exhausted — try credit fallback
          if (userId) {
            const credit = await tryDeductCredit(env, userId, 'ai_query');
            if (credit.success) {
              console.log(`credit deducted for ${userId}, remaining: ${credit.remaining}`);
              return {
                used: existing.daily_count,
                limit: limits.dailyQueries,
                remaining: 0,
                allowed: true,
                resetsAt: getNextResetTime(),
                paidVia: 'credits',
                creditsRemaining: credit.remaining,
              };
            }
          }
          // No credits available — check balance for error response
          const balance = userId ? await getCreditBalance(env, userId) : 0;
          return {
            used: existing.daily_count,
            limit: limits.dailyQueries,
            remaining: 0,
            allowed: false,
            resetsAt: getNextResetTime(),
            creditsRemaining: balance,
          };
        }
        // Increment count
        dailyCount = existing.daily_count + 1;
        await env.DB.prepare(
          'UPDATE usage SET daily_count = ?, tier = ?, user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE device_id = ?'
        ).bind(dailyCount, tier, userId || null, deviceId).run();
      }
    } else {
      // Create new record
      await env.DB.prepare(
        'INSERT INTO usage (device_id, user_id, daily_count, last_reset, tier) VALUES (?, ?, 1, ?, ?)'
      ).bind(deviceId, userId || null, today, tier).run();
      dailyCount = 1;
    }

    const allowed = dailyCount <= limits.dailyQueries;

    return {
      used: dailyCount,
      limit: limits.dailyQueries,
      remaining: Math.max(0, limits.dailyQueries - dailyCount),
      allowed,
      resetsAt: getNextResetTime(),
    };
  } catch (error) {
    console.error('Error tracking usage:', error);
    // On error, allow the request but log it
    return {
      used: 0,
      limit: limits.dailyQueries,
      remaining: limits.dailyQueries,
      allowed: true,
      resetsAt: getNextResetTime(),
    };
  }
}

/**
 * Get current usage status without incrementing
 */
export async function getUsageStatus(
  env: Env,
  deviceId: string,
  tier: UserTier
): Promise<UsageStatus> {
  const today = getTodayUTC();
  const limits = TIER_CONFIG[tier];

  let usedToday = 0;

  try {
    const existing = await env.DB.prepare(
      'SELECT daily_count, last_reset FROM usage WHERE device_id = ?'
    ).bind(deviceId).first<{ daily_count: number; last_reset: string }>();

    if (existing && existing.last_reset >= today) {
      usedToday = existing.daily_count;
    }
  } catch (error) {
    console.error('Error getting usage status:', error);
  }

  const limitToday = limits.dailyQueries;
  const remaining = Math.max(0, limits.dailyQueries - usedToday);

  const status: UsageStatus = {
    tier,
    used_today: usedToday,
    limit_today: limitToday,
    remaining,
    resets_at: getNextResetTime(),
    model_access: limits.allowedModels,
  };

  // Add upgrade options for non-subscribed users
  if (tier === 'anonymous') {
    status.upgrade_options = {
      login: { benefit: '+25 daily queries, more models' },
      subscribe: { benefit: 'Unlimited queries, all models including Claude Opus' },
    };
  } else if (tier === 'logged_in') {
    status.upgrade_options = {
      subscribe: { benefit: 'Unlimited queries, all models including Claude Opus' },
    };
  }

  return status;
}

/**
 * Check if a model is allowed for a given tier
 */
export function isModelAllowed(model: string, tier: UserTier): boolean {
  const allowedModels = TIER_CONFIG[tier].allowedModels;

  // Subscribed users can use any model
  if (allowedModels.includes('*')) {
    return true;
  }

  // Check if the model is in the allowed list
  return allowedModels.some(allowed =>
    model.toLowerCase().includes(allowed.toLowerCase()) ||
    allowed.toLowerCase().includes(model.toLowerCase())
  );
}

// Transcription tier limits (minutes-based)
// Only subscribed users (lifetime license or monthly) get cloud transcription
export const TRANSCRIPTION_TIER_CONFIG: Record<UserTier, TranscriptionTierLimits> = {
  anonymous: {
    totalMinutes: 0, // no cloud transcription
  },
  logged_in: {
    totalMinutes: 0, // no cloud transcription — must purchase to unlock
  },
  subscribed: {
    totalMinutes: 0, // 0 = unlimited for subscribers
  },
};

/**
 * Estimate audio duration in minutes from WAV Content-Length.
 * Assumes 16kHz, mono, 32-bit float (matches screenpipe's WAV format).
 * Falls back to 0.5 min if Content-Length is missing or unparseable.
 */
export function estimateAudioMinutes(contentLength: number | null, sampleRate = 16000): number {
  if (!contentLength || contentLength <= 44) return 0.5; // WAV header is 44 bytes, fallback to 30s
  const audioBytes = contentLength - 44; // strip WAV header
  const bytesPerSample = 4; // 32-bit float
  const samples = audioBytes / bytesPerSample;
  const seconds = samples / sampleRate;
  return Math.max(0.01, seconds / 60); // minimum 0.01 min
}

/**
 * Track transcription usage (minutes-based) and check if allowed.
 * Creates a record on first use with the tier's granted minutes.
 * Subscriber tier (totalMinutes=0) means unlimited.
 */
export async function trackTranscriptionUsage(
  env: Env,
  userId: string,
  tier: UserTier,
  audioMinutes: number,
): Promise<TranscriptionUsageResult> {
  const limits = TRANSCRIPTION_TIER_CONFIG[tier];

  // Subscribers get unlimited transcription
  if (limits.totalMinutes === 0 && tier === 'subscribed') {
    // Still track for analytics but always allow
    try {
      await env.DB.prepare(`
        INSERT INTO transcription_usage (user_id, minutes_used, minutes_granted, tier)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          minutes_used = minutes_used + ?,
          tier = ?,
          updated_at = datetime('now')
      `).bind(userId, audioMinutes, tier, audioMinutes, tier).run();
    } catch (e) {
      console.error('transcription tracking error (subscriber):', e);
    }
    return { minutesUsed: 0, minutesGranted: 0, minutesRemaining: 999999, allowed: true };
  }

  // Anonymous users get no cloud transcription
  if (tier === 'anonymous') {
    return { minutesUsed: 0, minutesGranted: 0, minutesRemaining: 0, allowed: false };
  }

  try {
    // Get or create usage record
    const existing = await env.DB.prepare(
      'SELECT minutes_used, minutes_granted FROM transcription_usage WHERE user_id = ?'
    ).bind(userId).first<{ minutes_used: number; minutes_granted: number }>();

    let minutesUsed: number;
    let minutesGranted: number;

    if (existing) {
      minutesUsed = existing.minutes_used;
      minutesGranted = existing.minutes_granted;
    } else {
      // First use — grant initial minutes
      minutesGranted = limits.totalMinutes;
      minutesUsed = 0;
      await env.DB.prepare(
        'INSERT INTO transcription_usage (user_id, minutes_used, minutes_granted, tier) VALUES (?, 0, ?, ?)'
      ).bind(userId, minutesGranted, tier).run();
    }

    const remaining = Math.max(0, minutesGranted - minutesUsed);

    // Check if this request would exceed quota
    if (remaining < audioMinutes) {
      // Try credit fallback (1 credit per minute of transcription)
      const creditsNeeded = Math.ceil(audioMinutes);
      const credit = await tryDeductCredit(env, userId, 'transcription');
      if (credit.success) {
        // Deducted 1 credit, allow request and track usage
        await env.DB.prepare(
          'UPDATE transcription_usage SET minutes_used = minutes_used + ?, tier = ?, updated_at = datetime(\'now\') WHERE user_id = ?'
        ).bind(audioMinutes, tier, userId).run();
        return {
          minutesUsed: minutesUsed + audioMinutes,
          minutesGranted,
          minutesRemaining: Math.max(0, remaining - audioMinutes),
          allowed: true,
          paidVia: 'credits',
          creditsRemaining: credit.remaining,
        };
      }

      // No credits — reject
      const balance = await getCreditBalance(env, userId);
      return {
        minutesUsed,
        minutesGranted,
        minutesRemaining: remaining,
        allowed: false,
        creditsRemaining: balance,
      };
    }

    // Within quota — track and allow
    await env.DB.prepare(
      'UPDATE transcription_usage SET minutes_used = minutes_used + ?, tier = ?, updated_at = datetime(\'now\') WHERE user_id = ?'
    ).bind(audioMinutes, tier, userId).run();

    return {
      minutesUsed: minutesUsed + audioMinutes,
      minutesGranted,
      minutesRemaining: Math.max(0, remaining - audioMinutes),
      allowed: true,
    };
  } catch (error) {
    console.error('Error tracking transcription usage:', error);
    // On error, allow the request (fail open)
    return { minutesUsed: 0, minutesGranted: limits.totalMinutes, minutesRemaining: limits.totalMinutes, allowed: true };
  }
}

/**
 * Get transcription usage status without incrementing
 */
export async function getTranscriptionStatus(
  env: Env,
  userId: string,
  tier: UserTier,
): Promise<{ minutesUsed: number; minutesGranted: number; minutesRemaining: number; tier: UserTier }> {
  const limits = TRANSCRIPTION_TIER_CONFIG[tier];

  if (tier === 'subscribed') {
    return { minutesUsed: 0, minutesGranted: 0, minutesRemaining: 999999, tier };
  }

  if (tier === 'anonymous') {
    return { minutesUsed: 0, minutesGranted: 0, minutesRemaining: 0, tier };
  }

  try {
    const existing = await env.DB.prepare(
      'SELECT minutes_used, minutes_granted FROM transcription_usage WHERE user_id = ?'
    ).bind(userId).first<{ minutes_used: number; minutes_granted: number }>();

    if (existing) {
      return {
        minutesUsed: existing.minutes_used,
        minutesGranted: existing.minutes_granted,
        minutesRemaining: Math.max(0, existing.minutes_granted - existing.minutes_used),
        tier,
      };
    }
  } catch (e) {
    console.error('Error getting transcription status:', e);
  }

  return { minutesUsed: 0, minutesGranted: limits.totalMinutes, minutesRemaining: limits.totalMinutes, tier };
}

