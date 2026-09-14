/**
 * Test bootstrap.
 *
 * The design-core specs use should.js (`x.should.be.true()`), which works by
 * augmenting `Object.prototype`. Importing it once here means each spec file
 * does not have to, and TypeScript picks up the augmentation project-wide.
 */
import "should"
