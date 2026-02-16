import { captureException, wrapRequestHandler } from '@sentry/cloudflare';
import { Env, RequestBody, AuthResult } from './types';
import { handleOptions, createSuccessResponse, createErrorResponse, addCorsHeaders } from './utils/cors';
import { validateAuth } from './utils/auth';
import { RateLimiter, checkRateLimit } from './utils/rate-limiter';
import { trackUsage, getUsageStatus, isModelAllowed, TIER_CONFIG, trackTranscriptionUsage, getTranscriptionStatus, estimateAudioMinutes } from './services/usage-tracker';
import { handleChatCompletions } from './handlers/chat';
import { handleModelListing } from './handlers/models';
import { handleFileTranscription, handleWebSocketUpgrade } from './handlers/transcription';
import { handleVoiceTranscription, handleVoiceQuery, handleTextToSpeech, handleVoiceChat } from './handlers/voice';
import { handleVertexProxy, handleVertexModels } from './handlers/vertex-proxy';
import { handleWebSearch } from './handlers/web-search';
// import { handleTTSWebSocketUpgrade } from './handlers/voice-ws';

export { RateLimiter };

// Handler function for the worker
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// Early test endpoint - before any initialization
	if (path === '/test') {
		return new Response('ai proxy is working!', { status: 200 });
	}

	try {
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		console.log('path', path);

		const upgradeHeader = request.headers.get('upgrade')?.toLowerCase();

		// Authenticate and get tier info for all endpoints
		const authResult = await validateAuth(request, env);
		console.log('auth result:', { tier: authResult.tier, deviceId: authResult.deviceId });

		// Handle WebSocket upgrade for real-time transcription (requires auth for metering)
		if (path === '/v1/listen' && upgradeHeader === 'websocket') {
			// WebSocket transcription: require logged-in user
			if (authResult.tier === 'anonymous') {
				return addCorsHeaders(createErrorResponse(401, JSON.stringify({
					error: 'authentication_required',
					message: 'Cloud transcription requires a screenpipe account. Please log in.',
				})));
			}
			// Check transcription quota before opening WebSocket
			const wsStatus = await getTranscriptionStatus(env, authResult.userId || authResult.deviceId, authResult.tier);
			if (wsStatus.minutesRemaining <= 0 && authResult.tier !== 'subscribed') {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: 'transcription_quota_exhausted',
					message: `You've used all ${wsStatus.minutesGranted} free transcription minutes. Buy credits or subscribe at screenpi.pe`,
					minutes_used: wsStatus.minutesUsed,
					minutes_granted: wsStatus.minutesGranted,
					minutes_remaining: 0,
					tier: authResult.tier,
				})));
			}
			return await handleWebSocketUpgrade(request, env);
		}

		// Check rate limit with tier info
		const rateLimit = await checkRateLimit(request, env, authResult);
		if (!rateLimit.allowed && rateLimit.response) {
			return rateLimit.response;
		}

		// Usage status endpoint - returns current usage without incrementing
		if (path === '/v1/usage' && request.method === 'GET') {
			const status = await getUsageStatus(env, authResult.deviceId, authResult.tier);
			const userId = authResult.userId || authResult.deviceId;
			const txStatus = await getTranscriptionStatus(env, userId, authResult.tier);
			return addCorsHeaders(createSuccessResponse({
				...status,
				transcription: txStatus,
			}));
		}

		// Chat completions - main AI endpoint
		if (path === '/v1/chat/completions' && request.method === 'POST') {
			const body = (await request.json()) as RequestBody;

			// Check if model is allowed for this tier
			if (!isModelAllowed(body.model, authResult.tier)) {
				const allowedModels = TIER_CONFIG[authResult.tier].allowedModels;
				return addCorsHeaders(createErrorResponse(403, JSON.stringify({
					error: 'model_not_allowed',
					message: `Model "${body.model}" is not available for your tier (${authResult.tier}). Available models: ${allowedModels.join(', ')}`,
					tier: authResult.tier,
					allowed_models: allowedModels,
				})));
			}

			// Track usage and check daily limit (includes IP-based abuse prevention)
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress);
			if (!usage.allowed) {
				const creditsExhausted = (usage.creditsRemaining ?? 0) <= 0;
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: creditsExhausted ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: creditsExhausted
						? `You've used all free queries and have no credits remaining. Buy more at screenpi.pe`
						: `You've used all ${usage.limit} free AI queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
					upgrade_options: {
						...(authResult.tier === 'anonymous'
							? { login: { benefit: '+25 daily queries, more models' } }
							: {}),
						buy_credits: {
							url: 'https://screenpi.pe/onboarding',
							benefit: 'Credits extend your daily limit — use anytime',
						},
						subscribe: {
							url: 'https://screenpi.pe/onboarding',
							benefit: '200 queries/day + 500 credits/mo + encrypted sync',
							price: '$29/mo',
						},
					},
				})));
			}

			// Add credit info header if paid via credits
			const response = await handleChatCompletions(body, env);
			if (usage.paidVia === 'credits' && usage.creditsRemaining !== undefined) {
				const newResponse = new Response(response.body, response);
				newResponse.headers.set('X-Credits-Remaining', String(usage.creditsRemaining));
				newResponse.headers.set('X-Paid-Via', 'credits');
				return newResponse;
			}
			return response;
		}

		// Web search endpoint - uses Gemini's Google Search grounding
		if (path === '/v1/web-search' && request.method === 'POST') {
			// Track usage (counts as 1 query)
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress);
			if (!usage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: (usage.creditsRemaining ?? 0) <= 0 ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: `You've used all ${usage.limit} free queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
				})));
			}
			return await handleWebSearch(request, env);
		}

		if (path === '/v1/listen' && request.method === 'POST') {
			// Require authentication for cloud transcription
			if (authResult.tier === 'anonymous') {
				return addCorsHeaders(createErrorResponse(401, JSON.stringify({
					error: 'authentication_required',
					message: 'Cloud transcription requires a screenpipe account. Please log in.',
				})));
			}

			// Estimate audio duration from Content-Length
			const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
			const sampleRate = parseInt(request.headers.get('sample_rate') || '16000', 10);
			const audioMinutes = estimateAudioMinutes(contentLength, sampleRate);

			// Track transcription usage (minutes-based)
			const userId = authResult.userId || authResult.deviceId;
			const txUsage = await trackTranscriptionUsage(env, userId, authResult.tier, audioMinutes);
			if (!txUsage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: 'transcription_quota_exhausted',
					message: `You've used all ${txUsage.minutesGranted} free transcription minutes. Buy credits or subscribe at screenpi.pe`,
					minutes_used: txUsage.minutesUsed,
					minutes_granted: txUsage.minutesGranted,
					minutes_remaining: 0,
					tier: authResult.tier,
					credits_remaining: txUsage.creditsRemaining ?? 0,
					upgrade_options: {
						buy_credits: {
							url: 'https://screenpi.pe/onboarding',
							benefit: 'Credits extend your transcription limit',
						},
						subscribe: {
							url: 'https://screenpi.pe/onboarding',
							benefit: 'Unlimited cloud transcription + 500 credits/mo',
							price: '$29/mo',
						},
					},
				})));
			}

			// Transcribe and add quota headers to response
			const txResponse = await handleFileTranscription(request, env);
			const txNewResponse = new Response(txResponse.body, txResponse);
			txNewResponse.headers.set('X-Transcription-Minutes-Used', String(txUsage.minutesUsed.toFixed(2)));
			txNewResponse.headers.set('X-Transcription-Minutes-Granted', String(txUsage.minutesGranted.toFixed(2)));
			txNewResponse.headers.set('X-Transcription-Minutes-Remaining', String(txUsage.minutesRemaining.toFixed(2)));
			if (txUsage.paidVia === 'credits') {
				txNewResponse.headers.set('X-Paid-Via', 'credits');
				txNewResponse.headers.set('X-Credits-Remaining', String(txUsage.creditsRemaining ?? 0));
			}
			return txNewResponse;
		}

		// Transcription usage status endpoint
		if (path === '/v1/transcription/usage' && request.method === 'GET') {
			const userId = authResult.userId || authResult.deviceId;
			const txStatus = await getTranscriptionStatus(env, userId, authResult.tier);
			return addCorsHeaders(createSuccessResponse(txStatus));
		}

		if (path === '/v1/models' && request.method === 'GET') {
			// Return tier-filtered models for non-subscribed users
			return await handleModelListing(env, authResult.tier);
		}

		if (path === '/v1/voice/transcribe' && request.method === 'POST') {
			return await handleVoiceTranscription(request, env);
		}

		if (path === '/v1/voice/query' && request.method === 'POST') {
			return await handleVoiceQuery(request, env);
		}

		if (path === '/v1/text-to-speech' && request.method === 'POST') {
			return await handleTextToSpeech(request, env);
		}

		if (path === '/v1/voice/chat' && request.method === 'POST') {
			return await handleVoiceChat(request, env);
		}

		// //TODO:
		// if (path === '/v1/tts-ws' && upgradeHeader === 'websocket') {
		// 	return await handleTTSWebSocketUpgrade(request, env);
		// }

		// Vertex AI proxy for Agent SDK
		// The Agent SDK sends requests to ANTHROPIC_VERTEX_BASE_URL/v1/messages
		if (path === '/v1/messages' && request.method === 'POST') {
			console.log('Vertex AI proxy request to /v1/messages');

			// Require authentication for Agent SDK
			if (authResult.tier === 'anonymous') {
				return addCorsHeaders(createErrorResponse(401, JSON.stringify({
					error: 'authentication_required',
					message: 'Vertex AI proxy requires authentication. Please log in to screenpipe.',
				})));
			}

			// Check model from body (clone request so proxy can still read it)
			const clonedRequest = request.clone();
			try {
				const body = (await clonedRequest.json()) as { model?: string };
				const model = body.model || 'claude-haiku-4-5-20251001';
				if (!isModelAllowed(model, authResult.tier)) {
					const allowedModels = TIER_CONFIG[authResult.tier].allowedModels;
					return addCorsHeaders(createErrorResponse(403, JSON.stringify({
						error: 'model_not_allowed',
						message: `Model "${model}" is not available for your tier (${authResult.tier}). Available models: ${allowedModels.join(', ')}`,
						tier: authResult.tier,
						allowed_models: allowedModels,
					})));
				}
			} catch (e) {
				// If body parse fails, let the proxy handle the error downstream
			}

			// Track usage and check daily limit
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress);
			if (!usage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: (usage.creditsRemaining ?? 0) <= 0 ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: `You've used all ${usage.limit} AI queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
				})));
			}

			return await handleVertexProxy(request, env);
		}

		// Anthropic-compatible endpoint for OpenCode integration
		// OpenCode sends requests to baseURL/v1/messages when configured with api: "anthropic"
		// Requires logged-in user (not anonymous)
		if (path === '/anthropic/v1/messages' && request.method === 'POST') {
			console.log('OpenCode Anthropic proxy request to /anthropic/v1/messages');

			// Require authentication for OpenCode
			if (authResult.tier === 'anonymous') {
				return addCorsHeaders(createErrorResponse(401, JSON.stringify({
					error: 'authentication_required',
					message: 'OpenCode requires authentication. Please log in to screenpipe.',
				})));
			}

			// Track usage for OpenCode requests
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress);
			if (!usage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: (usage.creditsRemaining ?? 0) <= 0 ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: `You've used all ${usage.limit} AI queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
				})));
			}

			return await handleVertexProxy(request, env);
		}

		// Anthropic models endpoint for OpenCode
		if (path === '/anthropic/v1/models' && request.method === 'GET') {
			console.log('OpenCode Anthropic models request');
			return await handleVertexModels(env);
		}

		return createErrorResponse(404, 'not found');
	} catch (error: any) {
		console.error('error in fetch:', error?.message, error?.stack);
		captureException(error);
		return createErrorResponse(500, error?.message || 'an error occurred');
	} finally {
	}
}

// Wrap with Sentry for error tracking
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return wrapRequestHandler(
			{
				options: {
					dsn: env.SENTRY_DSN,
					tracesSampleRate: 0.1,
				},
				request: request as any,
				context: ctx,
			},
			() => handleRequest(request, env, ctx)
		);
	},
} satisfies ExportedHandler<Env>;

/*
terminal 1

cd packages/ai-gateway
wrangler dev


terminal 2
HOST=https://api.screenpi.pe
HOST=http://localhost:8787
TOKEN=foobar (check app settings)
in
less "$HOME/Library/Application Support/screenpipe/store.bin"


curl $HOST/test


curl -X POST $HOST/v1/listen \
  -H "Content-Type: audio/wav" \
  -H "detect_language: en" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@./crates/screenpipe-audio/test_data/poetic_kapil_gupta.wav"

# Test free tier (no auth)
curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "X-Device-Id: test-device-123" \
-d '{
"model": "claude-haiku-4-5-20251001",
"messages": [
	{
	"role": "user",
	"content": "Tell me a short joke."
	}
],
"stream": true
}' | while read -r line; do
echo "$line" | sed 's/^data: //g' | jq -r '.choices[0].delta.content // empty' 2>/dev/null
done | tr -d '\n'

# Check usage
curl "$HOST/v1/usage" -H "X-Device-Id: test-device-123"

curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $TOKEN" \
-d '{
"model": "gpt-4o",
"messages": [
	{
	"role": "system",
	"content": "You are a helpful assistant."
	},
	{
	"role": "user",
	"content": "Tell me a short joke."
	}
],
"stream": true
}' | while read -r line; do
echo "$line" | sed 's/^data: //g' | jq -r '.choices[0].delta.content // empty' 2>/dev/null
done | tr -d '\n'

using anthropic

curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $TOKEN" \
-d '{
"model": "claude-3-5-sonnet-20240620",
"messages": [
	{
	"role": "system",
	"content": "You are a helpful assistant."
	},
	{
	"role": "user",
	"content": "Tell me a short joke."
	}
],
"stream": true
}' | while read -r line; do
echo "$line" | sed 's/^data: //g' | jq -r '.choices[0].delta.content // empty' 2>/dev/null
done | tr -d '\n'

using gemini

curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $TOKEN" \
-d '{
"model": "gemini-1.5-flash-latest",
"stream": true,
"messages": [
    {
        "role": "system",
        "content": "You are a helpful assistant."
    },
    {
        "role": "user",
        "content": "Tell me a short joke."
    }
]
}'

deployment

wrangler deploy

rate limit testing

# test openai endpoint (should hit limit faster)
for i in {1..25}; do
  echo "Request $i"
  curl -X POST "$HOST/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}' \
    -w "\nStatus: %{http_code}\n"
  sleep 0.1
done

*/
