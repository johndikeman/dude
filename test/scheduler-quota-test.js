const { parseQuotaError, isQuotaError } = require("../src/scheduler");
const assert = require("assert");

// Test cases for parseQuotaError with time
const testCasesWithTime = [
  {
    name: "quota with full time format",
    input:
      "Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h50m3s.",
    expectType: "quota_exhausted",
    expectTimeMs: 13803000, // 3h50m3s = 3*3600 + 50*60 + 3 = 13803 seconds = 13803000 ms
  },
  {
    name: "quota with hours and minutes",
    input:
      "API Error (429): capacity exhausted. Quota will reset after 2h30m.",
    expectType: "quota_exhausted",
    expectTimeMs: 9000000, // 2h30m = 9000 seconds = 9000000 ms
  },
  {
    name: "quota with just hours",
    input:
      "Error 429: exhausted your capacity. Quota will reset after 1h.",
    expectType: "quota_exhausted",
    expectTimeMs: 3600000, // 1h = 3600 seconds = 3600000 ms
  },
  {
    name: "quota with hours, minutes, and seconds",
    input:
      "429: You have exhausted your capacity. Quota will reset after 1h0m0s.",
    expectType: "quota_exhausted",
    expectTimeMs: 3600000, // 1h0m0s = 3600 seconds = 3600000 ms
  },
];

// Test cases for parseQuotaError without time - should still be detected
const testCasesWithoutTime = [
  {
    name: "quota exhausted without time",
    input:
      "Cloud Code Assist API error (429): You have exhausted your capacity on this model.",
    expectType: "quota_exhausted",
    expectTimeMs: 3600000, // default 1 hour
  },
  {
    name: "capacity exhausted without reset time",
    input: "Error: You have exhausted your capacity.",
    expectType: "quota_exhausted",
    expectTimeMs: 3600000, // default 1 hour
  },
  {
    name: "quota exhausted message, no time",
    input: "Quota exhausted. Please try again later.",
    expectType: "quota_exhausted",
    expectTimeMs: 3600000, // default 1 hour
  },
  {
    name: "rate limit exceeded",
    input: "Rate limit exceeded. Please wait before making more requests.",
    expectType: "quota_exhausted",
    expectTimeMs: 3600000, // default 1 hour
  },
];

// Test cases that should NOT be detected as quota errors
const nonQuotaTestCases = [
  {
    name: "text mentioning quota but not an error",
    input:
      "Now I understand the issue. The task is to enhance the tracking of pi sessions and handle quota errors that don't include a time.",
    shouldBeQuota: false,
  },
  {
    name: "text about quota handling",
    input:
      "The problem is that the regex looks for quota will reset after followed by a time pattern.",
    shouldBeQuota: false,
  },
  {
    name: "regular error without quota",
    input: "Connection timeout. Please check your network connection.",
    shouldBeQuota: false,
  },
  {
    name: "404 not found",
    input: "404: Resource not found.",
    shouldBeQuota: false,
  },
];

console.log("Running quota error parsing tests...\n");

// Run test cases with time
console.log("=== Test Cases WITH Time Specification ===");
for (const tc of testCasesWithTime) {
  const result = parseQuotaError(tc.input);
  if (result) {
    console.log(`✓ ${tc.name}: type=${result.type}`);
    console.log(`  time parsed: ${result.resetAfterMs}ms (expected: ${tc.expectTimeMs}ms)`);
    assert(result.type === tc.expectType, `Expected type ${tc.expectType}, got ${result.type}`);
    assert(result.resetAfterMs === tc.expectTimeMs, `Expected ${tc.expectTimeMs}ms, got ${result.resetAfterMs}ms`);
  } else {
    console.log(`✗ ${tc.name}: parseQuotaError returned null`);
    assert(false, `Should have parsed quota error`);
  }
  console.log();
}

// Run test cases without time
console.log("=== Test Cases WITHOUT Time Specification ===");
for (const tc of testCasesWithoutTime) {
  const result = parseQuotaError(tc.input);
  if (result) {
    console.log(`✓ ${tc.name}: type=${result.type}`);
    console.log(`  time parsed: ${result.resetAfterMs}ms (default: ${tc.expectTimeMs}ms)`);
    assert(result.type === tc.expectType, `Expected type ${tc.expectType}, got ${result.type}`);
    assert(result.resetAfterMs === tc.expectTimeMs, `Expected default ${tc.expectTimeMs}ms, got ${result.resetAfterMs}ms`);
  } else {
    console.log(`✗ ${tc.name}: parseQuotaError returned null`);
    assert(false, `Should have parsed quota error`);
  }
  console.log();
}

// Run negative test cases
console.log("=== Negative Test Cases (Should NOT match quota errors) ===");
for (const tc of nonQuotaTestCases) {
  const isQuota = isQuotaError(tc.input);
  console.log(tc.shouldBeQuota ? "✓" : "✓", `${tc.name}: detected=${isQuota}`);
  assert(isQuota === tc.shouldBeQuota, `Expected isQuotaError to return ${tc.shouldBeQuota}, got ${isQuota}`);
  console.log();
}

console.log("=== All tests passed! ===");
