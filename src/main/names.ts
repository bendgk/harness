/**
 * Agent callsigns: short, memorable names for root agent sessions, so a person
 * (or another agent) can say "@euclid" instead of a UUID.
 *
 * Only root sessions are named — the Claude Code / Codex process Paper runs.
 * Subagents live inside those processes and are never Paper sessions. Plain
 * shells are not agents and get no name.
 *
 * A name is stored on SessionMeta, so it follows the session through handoffs
 * (account, directory, machine), restarts and adoption from a remote tmux tag.
 */

/** Greek & Roman myth, mathematicians, scientists, inventors. Lowercase, ≤ 12 chars, no machine-ish words. */
export const NAME_POOL: readonly string[] = [
  // Greek
  'apollo', 'hermes', 'athena', 'artemis', 'hera', 'zeus', 'ares', 'demeter', 'dionysus', 'poseidon', 'hades',
  'persephone', 'prometheus', 'atlas', 'helios', 'selene', 'eos', 'nike', 'iris', 'hestia', 'orion', 'perseus',
  'theseus', 'achilles', 'hector', 'odysseus', 'ajax', 'jason', 'castor', 'pollux', 'calliope', 'clio', 'urania',
  'thalia', 'gaia', 'rhea', 'cronus', 'hyperion', 'themis', 'metis', 'nyx', 'pan', 'daedalus', 'icarus',
  // Roman
  'minerva', 'juno', 'mars', 'vesta', 'janus', 'diana', 'vulcan', 'mercury', 'ceres', 'aurora', 'luna', 'sol',
  'faunus', 'bacchus', 'neptune', 'pluto', 'saturn', 'jupiter', 'venus', 'fortuna', 'victoria', 'flora',
  // Mathematics
  'euclid', 'pythagoras', 'archimedes', 'hypatia', 'euler', 'gauss', 'riemann', 'noether', 'galois', 'fermat',
  'pascal', 'leibniz', 'turing', 'lovelace', 'ramanujan', 'hilbert', 'cantor', 'godel', 'fourier', 'laplace',
  'lagrange', 'cauchy', 'poincare', 'thales', 'zeno', 'fibonacci', 'descartes', 'napier', 'bernoulli', 'legendre',
  'jacobi', 'abel', 'dirichlet', 'chebyshev', 'kolmogorov', 'shannon', 'neumann', 'nash', 'erdos', 'eratosthenes',
  'ptolemy', 'heron', 'brahmagupta', 'khayyam', 'banach', 'markov', 'boole', 'babbage', 'conway', 'mandelbrot',
  // Science & invention
  'newton', 'kepler', 'galileo', 'copernicus', 'tesla', 'faraday', 'maxwell', 'curie', 'darwin', 'einstein',
  'bohr', 'planck', 'dirac', 'feynman', 'hubble', 'sagan', 'hawking', 'lorentz', 'kelvin', 'joule', 'volta',
  'ampere', 'ohm', 'hertz', 'boyle', 'hooke', 'halley', 'herschel', 'leonardo', 'raphael', 'donatello',
  'democritus', 'aristotle', 'plato', 'socrates', 'hippocrates', 'galen', 'lavoisier', 'mendel', 'pasteur',
  'meitner', 'franklin', 'hopper', 'heisenberg', 'schrodinger', 'fermi', 'pauli', 'rutherford', 'mendeleev'
]

/** Lowercase letter first, then letters/digits; 2–16 chars. Also what `@name` mentions match. */
const NAME_RE = /^[a-z][a-z0-9]{1,15}$/

export function isValidAgentName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && name !== 'local'
}

/** Normalise user input ("  Euclid ") to a candidate name, or null if it can't be one. */
export function normaliseAgentName(input: string): string | null {
  const n = input.trim().replace(/^@/, '').toLowerCase()
  return isValidAgentName(n) ? n : null
}

/**
 * Pick a free name. `taken` must hold every name in use (live sessions,
 * persisted records, agents seen on machines) and every machine alias,
 * lowercased — a name may never shadow a machine in `@` mentions.
 * Random from the pool; once the pool is exhausted, numbered (apollo2…).
 */
export function pickName(taken: ReadonlySet<string>, rand: () => number = Math.random): string {
  const free = NAME_POOL.filter((n) => !taken.has(n))
  if (free.length) return free[Math.floor(rand() * free.length)]
  for (let i = 2; ; i++) {
    for (const base of NAME_POOL) {
      const n = `${base}${i}`
      if (!taken.has(n)) return n
    }
  }
}
