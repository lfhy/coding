import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  'coding-client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
