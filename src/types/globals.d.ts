/**
 * Ambient types for the test environment.
 *
 * should.js works by augmenting `Object.prototype` at runtime. Importing its
 * types here is what tells TypeScript the same thing — without it every
 * `x.should` is an error even though the tests pass.
 */
import "should"
import "mocha"
