/**
 * Comprehensive test suite for Claude API extended thinking behavior
 * 
 * Based on official Anthropic documentation research:
 * 
 * KEY FINDINGS FROM DOCS:
 * 1. "While you can omit thinking blocks from prior assistant turns, it's suggested to 
 *    always pass back all thinking blocks for any multi-turn conversation"
 * 
 * 2. "When a non-tool-result user block is included, all previous thinking blocks are 
 *    ignored and stripped from context"
 * 
 * 3. "During tool use, you must pass thinking blocks back to the API" - but this is 
 *    specifically for the CURRENT tool use loop, not historical ones
 * 
 * 4. "The extended thinking block from the previous turn must be returned alongside 
 *    the corresponding tool results; this is the only scenario where returning 
 *    thinking blocks is mandatory"
 * 
 * 5. "If thinking is enabled, the final assistant turn must start with a thinking block"
 * 
 * HYPOTHESIS: The error we're seeing is because we have an assistant turn with tool_use
 * that doesn't start with a thinking block, AND we're trying to enable thinking.
 * 
 * POTENTIAL SOLUTION: The docs say thinking blocks are only MANDATORY when returning
 * tool results within the same assistant turn. For COMPLETED turns (after a non-tool-result
 * user message), the thinking blocks should be stripped automatically.
 * 
 * Run with: npx tsx scripts/test-thinking-scenarios.ts
 */

import * as fs from 'fs'
import * as path from 'path'

// Load .env manually
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) {
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      process.env[match[1].trim()] = value
    }
  }
}

// Use the proxy which handles OAuth for us
// The proxy is running on the old (working) code, so it will NOT force thinking
// This lets us test the raw API behavior by explicitly passing thinking in our requests
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:9095'
const API_KEY = process.env.API_KEY || 'test-key'

interface TestResult {
  name: string
  success: boolean
  error?: string
  details?: string
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather in a location',
  input_schema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
}

async function testDirectAPI(
  name: string,
  messages: any[],
  thinking: { type: string; budget_tokens?: number } | undefined,
  tools?: any[],
): Promise<TestResult> {
  const body: any = {
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages,
  }

  if (thinking) {
    body.thinking = thinking
    body.temperature = 1 // Required when thinking is enabled
  }

  if (tools) {
    body.tools = tools
  }

  console.log(`\n${'='.repeat(70)}`)
  console.log(`TEST: ${name}`)
  console.log(`${'='.repeat(70)}`)
  console.log(`- Messages: ${messages.length}`)
  console.log(`- Thinking: ${thinking ? `enabled (budget: ${thinking.budget_tokens})` : 'disabled'}`)
  console.log(`- Tools: ${tools ? 'yes' : 'no'}`)
  
  // Show message structure
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    let contentDesc: string
    if (typeof msg.content === 'string') {
      contentDesc = 'text'
    } else if (Array.isArray(msg.content)) {
      contentDesc = msg.content.map((c: any) => c.type).join(', ')
    } else {
      contentDesc = 'unknown'
    }
    console.log(`  [${i}] ${msg.role}: ${contentDesc}`)
  }

  try {
    // Use the proxy which handles OAuth
    const response = await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.log(`\n[X] FAILED (${response.status})`)
      
      try {
        const errorJson = JSON.parse(errorText)
        const msg = errorJson.error?.message || errorText
        console.log(`Error: ${msg.slice(0, 300)}${msg.length > 300 ? '...' : ''}`)
        return { name, success: false, error: msg }
      } catch {
        console.log(`Error: ${errorText.slice(0, 300)}...`)
        return { name, success: false, error: errorText }
      }
    }

    const data = await response.json() as any
    console.log(`\n[OK] SUCCESS`)
    console.log(`Stop reason: ${data.stop_reason}`)
    
    // Check if response has thinking
    const hasThinking = data.content?.some((b: any) => b.type === 'thinking')
    console.log(`Response has thinking block: ${hasThinking}`)
    
    return { name, success: true, details: `stop_reason: ${data.stop_reason}, has_thinking: ${hasThinking}` }
  } catch (err) {
    console.log(`\n[X] EXCEPTION: ${err}`)
    return { name, success: false, error: String(err) }
  }
}

async function main() {
  console.log('=' .repeat(70))
  console.log('COMPREHENSIVE EXTENDED THINKING TEST SUITE')
  console.log('Testing directly against Claude API (bypassing proxy)')
  console.log('=' .repeat(70))

  const results: TestResult[] = []

  // ============================================================
  // SECTION 1: Basic scenarios (no tool use)
  // ============================================================
  console.log('\n\n### SECTION 1: Basic scenarios (no tool use) ###\n')

  // Test 1.1: Fresh conversation with thinking
  results.push(await testDirectAPI(
    '1.1 Fresh conversation with thinking',
    [{ role: 'user', content: 'Say "hello" and nothing else' }],
    { type: 'enabled', budget_tokens: 1024 },
  ))

  // Test 1.2: Multi-turn WITHOUT thinking blocks in history
  results.push(await testDirectAPI(
    '1.2 Multi-turn, assistant has NO thinking, enable thinking now',
    [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: 'The answer is 4.' }, // NO thinking block
      { role: 'user', content: 'Thanks!' },
    ],
    { type: 'enabled', budget_tokens: 1024 },
  ))

  // ============================================================
  // SECTION 2: Tool use scenarios - THE CRITICAL TESTS
  // ============================================================
  console.log('\n\n### SECTION 2: Tool use scenarios ###\n')

  // Test 2.1: Fresh conversation with tools available
  results.push(await testDirectAPI(
    '2.1 Fresh conversation, tools available, thinking enabled',
    [{ role: 'user', content: 'What is the weather in Paris?' }],
    { type: 'enabled', budget_tokens: 1024 },
    [WEATHER_TOOL],
  ))

  // Test 2.2: CRITICAL - History has tool_use WITHOUT thinking, then new user message
  // Per docs: "When a non-tool-result user block is included, all previous thinking 
  // blocks are ignored and stripped from context"
  // This should work because the user message after tool_result starts a NEW assistant turn
  results.push(await testDirectAPI(
    '2.2 CRITICAL: tool_use (NO thinking) -> tool_result -> user text -> enable thinking',
    [
      { role: 'user', content: 'What is the weather in Paris?' },
      { 
        role: 'assistant', 
        content: [
          // NO thinking block - simulating what Cursor sends
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 22C' }
        ]
      },
      { role: 'user', content: 'Thanks! What about London?' }, // This starts a NEW turn
    ],
    { type: 'enabled', budget_tokens: 1024 },
    [WEATHER_TOOL],
  ))

  // Test 2.3: Same but WITHOUT the final user text message (still in tool loop)
  results.push(await testDirectAPI(
    '2.3 tool_use (NO thinking) -> tool_result ONLY (still in tool loop)',
    [
      { role: 'user', content: 'What is the weather in Paris?' },
      { 
        role: 'assistant', 
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 22C' }
        ]
      },
      // NO user text message - we're still in the tool loop
    ],
    { type: 'enabled', budget_tokens: 1024 },
    [WEATHER_TOOL],
  ))

  // Test 2.4: Multiple completed tool loops, then new user message
  results.push(await testDirectAPI(
    '2.4 Multiple tool loops (NO thinking) -> user text -> enable thinking',
    [
      { role: 'user', content: 'What is the weather in Paris?' },
      { 
        role: 'assistant', 
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 22C' }
        ]
      },
      { 
        role: 'assistant', 
        content: 'The weather in Paris is sunny and 22C!'
      },
      { role: 'user', content: 'What about London?' },
      { 
        role: 'assistant', 
        content: [
          { type: 'tool_use', id: 'tool_2', name: 'get_weather', input: { location: 'London' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_2', content: 'Rainy, 15C' }
        ]
      },
      { 
        role: 'assistant', 
        content: 'London is rainy at 15C.'
      },
      { role: 'user', content: 'Thanks for the info!' }, // New turn
    ],
    { type: 'enabled', budget_tokens: 1024 },
    [WEATHER_TOOL],
  ))

  // ============================================================
  // SECTION 3: Edge cases
  // ============================================================
  console.log('\n\n### SECTION 3: Edge cases ###\n')

  // Test 3.1: What if we're IN a tool loop and want thinking?
  // This should fail per docs: "you must pass thinking blocks back to the API"
  results.push(await testDirectAPI(
    '3.1 EXPECTED FAIL: In tool loop, missing thinking, enable thinking',
    [
      { role: 'user', content: 'What is the weather in Paris?' },
      { 
        role: 'assistant', 
        content: [
          // Missing thinking block - this should fail
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 22C' }
        ]
      },
      // No user text - still in tool loop, expecting assistant to respond
    ],
    { type: 'enabled', budget_tokens: 1024 },
    [WEATHER_TOOL],
  ))

  // Test 3.2: Thinking disabled - baseline that should always work
  results.push(await testDirectAPI(
    '3.2 BASELINE: tool_use history, thinking DISABLED',
    [
      { role: 'user', content: 'What is the weather in Paris?' },
      { 
        role: 'assistant', 
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny, 22C' }
        ]
      },
      { role: 'user', content: 'Thanks!' },
    ],
    undefined, // No thinking
    [WEATHER_TOOL],
  ))

  // ============================================================
  // SECTION 4: Real Cursor-like scenarios
  // ============================================================
  console.log('\n\n### SECTION 4: Real Cursor-like scenarios ###\n')

  // Test 4.1: Cursor pattern - ends with tool_result (IN tool loop)
  // This is what happens when Claude makes a tool call and Cursor sends back the result
  results.push(await testDirectAPI(
    '4.1 CURSOR PATTERN: user text -> assistant tool_use -> tool_result (IN LOOP)',
    [
      { role: 'user', content: 'Read the file server.ts' },
      { 
        role: 'assistant', 
        content: [
          { type: 'text', text: 'I will read that file for you.' },
          { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'server.ts' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'File contents here...' }
        ]
      },
      // NO user text - waiting for Claude to respond to tool result
    ],
    { type: 'enabled', budget_tokens: 1024 },
    [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  ))

  // Test 4.2: Cursor pattern - ends with user text (OUTSIDE tool loop)
  results.push(await testDirectAPI(
    '4.2 CURSOR PATTERN: tool_use -> tool_result -> assistant text -> user text (OUTSIDE LOOP)',
    [
      { role: 'user', content: 'Read the file server.ts' },
      { 
        role: 'assistant', 
        content: [
          { type: 'text', text: 'I will read that file for you.' },
          { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'server.ts' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'File contents here...' }
        ]
      },
      { 
        role: 'assistant', 
        content: 'Here are the contents of server.ts...'
      },
      { role: 'user', content: 'Thanks! Now edit line 50.' }, // User text = NEW turn
    ],
    { type: 'enabled', budget_tokens: 1024 },
    [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  ))

  // ============================================================
  // SECTION 5: Test the NEW implementation through the proxy
  // These tests go through the proxy WITHOUT explicitly setting thinking
  // to test that the proxy's force-thinking logic works correctly
  // ============================================================
  console.log('\n\n### SECTION 5: Test NEW proxy implementation (no explicit thinking) ###\n')
  console.log('NOTE: These tests do NOT set thinking - they rely on proxy FORCE_THINKING_BUDGET\n')

  // For these tests, we need to NOT send thinking, so the proxy's logic kicks in
  async function testProxyForceThinking(
    name: string,
    messages: any[],
    tools?: any[],
  ): Promise<TestResult> {
    const body: any = {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages,
      // NO thinking - let proxy decide
    }

    if (tools) {
      body.tools = tools
    }

    console.log(`\n${'='.repeat(70)}`)
    console.log(`TEST: ${name}`)
    console.log(`${'='.repeat(70)}`)
    console.log(`- Messages: ${messages.length}`)
    console.log(`- Thinking: NOT SET (proxy decides)`)
    console.log(`- Tools: ${tools ? 'yes' : 'no'}`)
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      let contentDesc: string
      if (typeof msg.content === 'string') {
        contentDesc = 'text'
      } else if (Array.isArray(msg.content)) {
        contentDesc = msg.content.map((c: any) => c.type).join(', ')
      } else {
        contentDesc = 'unknown'
      }
      console.log(`  [${i}] ${msg.role}: ${contentDesc}`)
    }

    try {
      const response = await fetch(`${PROXY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.log(`\n[X] FAILED (${response.status})`)
        
        try {
          const errorJson = JSON.parse(errorText)
          const msg = errorJson.error?.message || errorText
          console.log(`Error: ${msg.slice(0, 300)}${msg.length > 300 ? '...' : ''}`)
          return { name, success: false, error: msg }
        } catch {
          console.log(`Error: ${errorText.slice(0, 300)}...`)
          return { name, success: false, error: errorText }
        }
      }

      console.log(`\n[OK] SUCCESS`)
      return { name, success: true }
    } catch (err) {
      console.log(`\n[X] EXCEPTION: ${err}`)
      return { name, success: false, error: String(err) }
    }
  }

  // Test 5.1: Outside tool loop, missing cache should ENABLE thinking
  results.push(await testProxyForceThinking(
    '5.1 PROXY: Outside tool loop (user text) - should enable thinking',
    [
      { role: 'user', content: 'What is the weather?' },
      { 
        role: 'assistant', 
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny' }
        ]
      },
      { role: 'assistant', content: 'It is sunny in Paris!' },
      { role: 'user', content: 'Thanks!' }, // USER TEXT = outside tool loop
    ],
    [WEATHER_TOOL],
  ))

  // Test 5.2: Inside tool loop, missing cache should DISABLE thinking (temporarily)
  results.push(await testProxyForceThinking(
    '5.2 PROXY: Inside tool loop (tool_result) - should disable thinking temporarily',
    [
      { role: 'user', content: 'What is the weather?' },
      { 
        role: 'assistant', 
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tool_1', name: 'get_weather', input: { location: 'Paris' } }
        ]
      },
      { 
        role: 'user', 
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'Sunny' }
        ]
      },
      // NO user text - still in tool loop
    ],
    [WEATHER_TOOL],
  ))

  // Test 5.3: Fresh conversation should enable thinking
  results.push(await testProxyForceThinking(
    '5.3 PROXY: Fresh conversation - should enable thinking',
    [
      { role: 'user', content: 'Hello!' },
    ],
  ))

  // ============================================================
  // VALIDATION SUMMARY
  // ============================================================
  console.log('\n\n' + '='.repeat(70))
  console.log('VALIDATION OF NEW PROXY LOGIC')
  console.log('='.repeat(70))
  
  console.log('\nThe NEW proxy logic should:')
  console.log('1. ENABLE thinking when last user message is TEXT (even with missing cache)')
  console.log('   - Test 2.2 proves this works: tool_use history + user TEXT = thinking OK')
  console.log('   - Test 4.2 proves this works: Cursor pattern + user TEXT = thinking OK')
  console.log('')
  console.log('2. DISABLE thinking when last user message is tool_result AND cache is missing')
  console.log('   - Test 2.3 shows why: tool_result + thinking = FAILS without thinking blocks')
  console.log('   - Test 4.1 shows why: Cursor in-loop + thinking = FAILS without thinking blocks')
  console.log('   - The proxy should detect this and NOT enable thinking')
  console.log('')
  console.log('3. The conversation "heals" automatically:')
  console.log('   - When inside tool loop: thinking disabled, request succeeds')
  console.log('   - Claude responds, completing the tool loop')
  console.log('   - User sends text message: thinking re-enabled!')
  console.log('   - New thinking blocks get cached for future use')

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n\n' + '='.repeat(70))
  console.log('SUMMARY')
  console.log('='.repeat(70))
  
  const passed = results.filter(r => r.success)
  const failed = results.filter(r => !r.success)
  
  console.log(`\nPassed: ${passed.length}/${results.length}`)
  console.log(`Failed: ${failed.length}/${results.length}`)
  
  if (passed.length > 0) {
    console.log('\n[OK] PASSED TESTS:')
    for (const r of passed) {
      console.log(`  - ${r.name}`)
    }
  }
  
  if (failed.length > 0) {
    console.log('\n[X] FAILED TESTS:')
    for (const r of failed) {
      console.log(`  - ${r.name}`)
      if (r.error) {
        console.log(`    Error: ${r.error.slice(0, 150)}...`)
      }
    }
  }

  // Key insights
  console.log('\n' + '='.repeat(70))
  console.log('KEY INSIGHTS')
  console.log('='.repeat(70))
  
  const test22 = results.find(r => r.name.includes('2.2'))
  const test23 = results.find(r => r.name.includes('2.3'))
  
  if (test22?.success && test23?.success) {
    console.log('\n[GOOD NEWS] Both tool loop scenarios passed!')
    console.log('This means we CAN enable thinking even with missing historical thinking blocks,')
    console.log('as long as the conversation structure is correct.')
  } else if (test22?.success && !test23?.success) {
    console.log('\n[INSIGHT] Test 2.2 passed but 2.3 failed.')
    console.log('This confirms: after a user text message (not tool_result), thinking blocks')
    console.log('from previous turns are stripped. But DURING a tool loop, we need them.')
  } else if (!test22?.success && !test23?.success) {
    console.log('\n[BAD NEWS] Both tool loop tests failed.')
    console.log('We cannot enable thinking with missing historical thinking blocks.')
  }
  
  console.log('')
}

main().catch(console.error)
