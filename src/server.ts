import { Hono, Context } from 'hono'
import { serve } from '@hono/node-server'
import { stream } from 'hono/streaming'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getAccessToken } from './auth/oauth-manager'
import {
  login as oauthLogin,
  logout as oauthLogout,
  generateAuthSession,
  handleOAuthCallback,
} from './auth/oauth-flow'
import {
  createConverterState,
  processChunk,
  convertNonStreamingResponse,
} from './utils/anthropic-to-openai-converter'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'
import type {
  AnthropicRequestBody,
  AnthropicResponse,
  ErrorResponse,
  SuccessResponse,
  ModelsListResponse,
  ModelInfo,
} from './types'

// Static files are served by Vercel, not needed here

const app = new Hono()

// Models that support extended thinking (per Anthropic docs)
const thinkingCapableModels = new Set<string>([
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-20250514',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-3-7-sonnet-20250219',
])

const supportsExtendedThinking = (model: string) =>
  thinkingCapableModels.has(model)

const enableRequestLogging = process.env.LOG_REQUEST_DEBUG === 'true'
const forcedMaxTokensValue = Number(process.env.FORCE_MAX_TOKENS || '')
const enableInterleavedThinking =
  process.env.ENABLE_INTERLEAVED_THINKING === 'true'
const logFile =
  process.env.LOG_REQUEST_FILE || join(process.cwd(), 'logs', 'requests.log')

let logDirReady = false

const logRequest = async (label: string, payload: unknown) => {
  if (!enableRequestLogging) return
  try {
    if (!logDirReady) {
      await mkdir(dirname(logFile), { recursive: true })
      logDirReady = true
    }
    const entry = {
      ts: new Date().toISOString(),
      label,
      payload,
    }
    await appendFile(logFile, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    // Swallow logging errors to avoid impacting proxy
  }
}

// Conservative model max-token map (total output cap including thinking)
const modelMaxTokens: Record<string, number> = {
  'claude-opus-4-5': 64_000,
  'claude-opus-4-5-20251101': 64_000,
  'claude-opus-4-1': 64_000,
  'claude-opus-4-1-20250805': 64_000,
  'claude-opus-4-0': 64_000,
  'claude-opus-4-20250514': 64_000,
  'claude-sonnet-4-5': 64_000,
  'claude-sonnet-4-5-20250929': 64_000,
  'claude-sonnet-4-20250514': 64_000,
  'claude-haiku-4-5': 64_000,
  'claude-haiku-4-5-20251001': 64_000,
  'claude-3-7-sonnet-20250219': 64_000,
  // fallback below
}

const getModelMaxTokens = (model: string) => modelMaxTokens[model] ?? 64_000

// Handle CORS preflight requests for all routes
app.options('*', corsPreflightHandler)

// Also add CORS headers to all responses
app.use('*', corsMiddleware)

const indexHtmlPath = join(process.cwd(), 'public', 'index.html')
let cachedIndexHtml: string | null = null

const getIndexHtml = async () => {
  if (!cachedIndexHtml) {
    cachedIndexHtml = await readFile(indexHtmlPath, 'utf-8')
  }
  return cachedIndexHtml
}

// Root route is handled by serving public/index.html directly
app.get('/', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

app.get('/index.html', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

// New OAuth start endpoint for UI
app.post('/auth/oauth/start', async (c: Context) => {
  try {
    const { authUrl, sessionId } = await generateAuthSession()

    return c.json({
      success: true,
      authUrl,
      sessionId,
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Failed to start OAuth flow',
        message: (error as Error).message,
      },
      500,
    )
  }
})

// New OAuth callback endpoint for UI
app.post('/auth/oauth/callback', async (c: Context) => {
  try {
    const body = await c.req.json()
    const { code } = body

    if (!code) {
      return c.json<ErrorResponse>(
        {
          error: 'Missing OAuth code',
          message: 'OAuth code is required',
        },
        400,
      )
    }

    // Extract verifier from code if it contains #
    const splits = code.split('#')
    const verifier = splits[1] || ''

    await handleOAuthCallback(code, verifier)

    return c.json<SuccessResponse>({
      success: true,
      message: 'OAuth authentication successful',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'OAuth callback failed',
        message: (error as Error).message,
      },
      500,
    )
  }
})

app.post('/auth/login/start', async (c: Context) => {
  try {
    console.log('\n Starting OAuth authentication flow...')
    const result = await oauthLogin()
    if (result) {
      return c.json<SuccessResponse>({
        success: true,
        message: 'OAuth authentication successful',
      })
    } else {
      return c.json<SuccessResponse>(
        { success: false, message: 'OAuth authentication failed' },
        401,
      )
    }
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/logout', async (c: Context) => {
  try {
    await oauthLogout()
    return c.json<SuccessResponse>({
      success: true,
      message: 'Logged out successfully',
    })
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/status', async (c: Context) => {
  try {
    const token = await getAccessToken()
    return c.json({ authenticated: !!token })
  } catch (error) {
    return c.json({ authenticated: false })
  }
})

app.get('/v1/models', async (c: Context) => {
  try {
    // Fetch models from models.dev
    const response = await fetch('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      },
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const modelsData = (await response.json()) as any

    // Extract Anthropic models and format them like OpenAI's API would
    const anthropicProvider = modelsData.anthropic
    if (!anthropicProvider || !anthropicProvider.models) {
      return c.json<ModelsListResponse>({
        object: 'list',
        data: [],
      })
    }

    // Convert models to OpenAI's format
    const models: ModelInfo[] = Object.entries(anthropicProvider.models).map(
      ([modelId, modelData]: [string, any]) => {
        // Convert release date to Unix timestamp
        const releaseDate = modelData.release_date || '1970-01-01'
        const created = Math.floor(new Date(releaseDate).getTime() / 1000)

        return {
          id: modelId,
          object: 'model' as const,
          created: created,
          owned_by: 'anthropic',
        }
      },
    )

    // Sort models by created timestamp (newest first)
    models.sort((a, b) => b.created - a.created)

    const response_data: ModelsListResponse = {
      object: 'list',
      data: models,
    }

    return c.json(response_data)
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
})

const messagesFn = async (c: Context) => {
  let headers: Record<string, string> = c.req.header() as Record<string, string>
  headers.host = 'api.anthropic.com'
  const body: AnthropicRequestBody = await c.req.json()
  const incomingBodySnapshot = JSON.parse(JSON.stringify(body))
  const isStreaming = body.stream === true

  // Lightweight console notice for visibility
  console.log(`[proxy] request received ${new Date().toISOString()}`)

  await logRequest('incoming-request', {
    path: c.req.path,
    model: body.model,
    hasThinking: !!(body as any).thinking,
    thinkingType: (body as any).thinking?.type,
    thinkingBudget: (body as any).thinking?.budget_tokens,
    hasTools: Array.isArray((body as any).tools),
    toolsCount: Array.isArray((body as any).tools)
      ? (body as any).tools.length
      : 0,
    hasFunctions: Array.isArray((body as any).functions),
    messagesPreview: Array.isArray(body.messages)
      ? body.messages.slice(0, 2)
      : undefined,
    stream: isStreaming,
    body: incomingBodySnapshot,
  })

  const apiKey = c.req.header('authorization')?.split(' ')?.[1]
  if (apiKey && apiKey !== process.env.API_KEY) {
    return c.json(
      {
        error: 'Authentication required',
        message: 'Please authenticate use the API key from the .env file',
      },
      401,
    )
  }

  // Bypass cursor enable openai key check
  if (isCursorKeyCheck(body)) {
    return c.json(createCursorBypassResponse())
  }

  try {
    let transformToOpenAIFormat = false

    if (
      !body.system?.[0]?.text?.includes(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      ) && body.messages
    ) {
      const systemMessages = body.messages.filter((msg: any) => msg.role === 'system')
      body.messages = body.messages?.filter((msg: any) => msg.role !== 'system')
      transformToOpenAIFormat = true // not claude-code, need to transform to openai format
      if (!body.system) {
        body.system = []
      }
      body.system.unshift({
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      })

      for (const sysMsg of systemMessages) {
        body.system.push({
          type: 'text',
          text: sysMsg.content || ''
        })
      }

      if (body.model.includes('opus')) {
        body.max_tokens = 32_000
      }
      if (body.model.includes('sonnet')) {
        body.max_tokens = 64_000
      }
    }

    const oauthToken = await getAccessToken()

    if (!oauthToken) {
      return c.json<ErrorResponse>(
        {
          error: 'Authentication required',
          message:
            'Please authenticate using OAuth first. Visit /auth/login for instructions.',
        },
        401,
      )
    }

    const betaHeaders = [
      'oauth-2025-04-20',
      'fine-grained-tool-streaming-2025-05-14',
    ]
    if (enableInterleavedThinking) {
      betaHeaders.push('interleaved-thinking-2025-05-14')
    }

    headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${oauthToken}`,
      'anthropic-beta': betaHeaders.join(','),
      'anthropic-version': '2023-06-01',
      'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      accept: isStreaming ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'gzip, deflate',
    }

    if (transformToOpenAIFormat) {
      if (!body.metadata) {
        body.metadata = {}
      }

      if (!body.system) {
        body.system = []
      }
    }

    // Optionally force extended thinking for supported models when env is set
    const forceThinkingBudget = Number(process.env.FORCE_THINKING_BUDGET || '')
    if (
      Number.isFinite(forceThinkingBudget) &&
      forceThinkingBudget > 0 &&
      !body.thinking &&
      supportsExtendedThinking(body.model)
    ) {
      const newThinking: any = {
        type: 'enabled',
        budget_tokens: forceThinkingBudget,
      }
      body.thinking = newThinking

      const incomingMax =
        typeof body.max_tokens === 'number' ? body.max_tokens : null
      const modelCap = getModelMaxTokens(body.model)

    let usedFallbackMax = false
    let effectiveMaxTokens = incomingMax

    if (incomingMax !== null) {
      // Respect caller max_tokens; adjust thinking budget to fit within cap
      const maxThinkingPossible = Math.max(0, modelCap - incomingMax)
      if (newThinking.budget_tokens > maxThinkingPossible) {
        newThinking.budget_tokens = maxThinkingPossible
      }
    } else {
      // No caller max_tokens: choose a fallback and cap to model limit
      const fallback = Math.max(forceThinkingBudget + 6000, forceThinkingBudget * 2)
      usedFallbackMax = true
      const cappedFallback = Math.min(fallback, modelCap)
      effectiveMaxTokens = cappedFallback
      newThinking.budget_tokens = Math.min(newThinking.budget_tokens, cappedFallback)
      body.max_tokens = cappedFallback
    }

      await logRequest('forced-thinking-applied', {
        model: body.model,
        incomingMaxTokens: incomingMax,
        budgetTokens: newThinking.budget_tokens,
      outgoingMaxTokens: body.max_tokens ?? effectiveMaxTokens ?? null,
      cappedAtModelMax:
        typeof (body.max_tokens ?? effectiveMaxTokens) === 'number'
          ? ((body.max_tokens ?? effectiveMaxTokens) as number) >= modelCap
          : false,
        usedFallbackMax,
      })
    }

    // When thinking is enabled, inject placeholder thinking blocks into assistant messages
    // that don't already have them (Claude API requires this for multi-turn conversations)
    if (body.thinking && Array.isArray(body.messages)) {
      let injectedCount = 0
      for (const msg of body.messages) {
        if (msg.role !== 'assistant') continue
        // Convert string content to array form
        if (typeof msg.content === 'string') {
          msg.content = [{ type: 'text', text: msg.content }]
        }
        if (!Array.isArray(msg.content)) continue
        // Check if first block is already thinking/redacted_thinking
        const firstBlock = msg.content[0]
        if (
          firstBlock &&
          (firstBlock.type === 'thinking' || firstBlock.type === 'redacted_thinking')
        ) {
          continue
        }
        // Prepend a minimal thinking block
        msg.content.unshift({
          type: 'thinking',
          thinking: '...',
        })
        injectedCount++
      }
      if (injectedCount > 0) {
        await logRequest('injected-thinking-blocks', {
          model: body.model,
          injectedCount,
        })
      }
    }

    await logRequest('outgoing-request', {
      model: body.model,
      hasThinking: !!(body as any).thinking,
      thinkingType: (body as any).thinking?.type,
      thinkingBudget: (body as any).thinking?.budget_tokens,
      hasTools: Array.isArray((body as any).tools),
      toolsCount: Array.isArray((body as any).tools)
        ? (body as any).tools.length
        : 0,
      messagesCount: Array.isArray(body.messages) ? body.messages.length : 0,
      stream: isStreaming,
      body: JSON.parse(JSON.stringify(body)),
    })

  // Optionally force max_tokens to a fixed value
  if (Number.isFinite(forcedMaxTokensValue) && forcedMaxTokensValue > 0) {
    const cap = getModelMaxTokens(body.model)
    const forcedValue = Math.min(forcedMaxTokensValue, cap)
    const originalMax =
      typeof body.max_tokens === 'number' ? body.max_tokens : null
    if (originalMax === null || originalMax !== forcedValue) {
      await logRequest('forced-max-tokens', {
        model: body.model,
        originalMaxTokens: originalMax,
        forcedMaxTokens: forcedValue,
      })
      body.max_tokens = forcedValue
    }
  }

  // Final safety cap to model limit
  const finalCap = getModelMaxTokens(body.model)
  if (typeof body.max_tokens === 'number' && body.max_tokens > finalCap) {
    await logRequest('max-tokens-capped', {
      model: body.model,
      originalMaxTokens: body.max_tokens,
      cappedTo: finalCap,
    })
    body.max_tokens = finalCap
  }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      await logRequest('response-error', {
        model: body.model,
        status: response.status,
        statusText: response.statusText,
        requestId: response.headers.get('request-id'),
        bodySnippet: error.length > 2000 ? `${error.slice(0, 2000)}...` : error,
      })
      console.error('API Error:', error)

      if (response.status === 401) {
        return c.json<ErrorResponse>(
          {
            error: 'Authentication failed',
            message:
              'OAuth token may be expired. Please re-authenticate using /auth/login/start',
            details: error,
          },
          401,
        )
      }
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    if (isStreaming) {
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== 'content-encoding' &&
          key.toLowerCase() !== 'content-length' &&
          key.toLowerCase() !== 'transfer-encoding'
        ) {
          c.header(key, value)
        }
      })

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      return stream(c, async (stream) => {
        const converterState = createConverterState()
        const enableLogging = false

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })

            if (transformToOpenAIFormat) {
              if (enableLogging) {
                console.log('🔄 [TRANSFORM MODE] Converting to OpenAI format')
              }

              const results = processChunk(converterState, chunk, enableLogging)

              for (const result of results) {
                if (result.type === 'chunk') {
                  const dataToSend = `data: ${JSON.stringify(result.data)}\n\n`
                  if (enableLogging) {
                    console.log('✅ [SENDING] OpenAI Chunk:', dataToSend)
                  }
                  await stream.write(dataToSend)
                } else if (result.type === 'done') {
                  await stream.write('data: [DONE]\n\n')
                }
              }
            } else {
              await stream.write(chunk)
            }
          }
        } catch (error) {
          console.error('Stream error:', error)
        } finally {
          reader.releaseLock()
        }
      })
    } else {
      const responseData = (await response.json()) as AnthropicResponse

      if (transformToOpenAIFormat) {
        const openAIResponse = convertNonStreamingResponse(responseData)

        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-encoding') {
            c.header(key, value)
          }
        })

        return c.json(openAIResponse)
      }

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          c.header(key, value)
        }
      })

      return c.json(responseData)
    }
  } catch (error) {
    await logRequest('response-exception', {
      model: body.model,
      error: (error as Error).message,
      stack: (error as Error).stack,
    })
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
}

app.post('/v1/chat/completions', messagesFn)
app.post('/v1/messages', messagesFn)

const port = Number(process.env.PORT) || 9095

// Start local server when not running on Vercel
if (!process.env.VERCEL) {
  console.log(`🚀 Listening locally on http://localhost:${port}`)
  serve({
    fetch: app.fetch,
    port,
  })
}

// Export app for Vercel
export default app
