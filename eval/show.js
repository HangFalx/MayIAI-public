const r = require('../results/results.json');
const ids = process.argv.slice(2);
for (const x of r.results.filter((x) => ids.length === 0 ? !x.success : ids.includes(x.id))) {
  console.log(`== ${x.system} ${x.id} run ${x.run}: ${x.failures.join('; ')}`);
  for (const t of x.transcript) console.log(`  ${t.role}: ${t.text}`);
  for (const c of x.toolCalls) console.log(`  [tool] ${c.name} ${c.arguments} ok=${c.ok} ${c.error ?? ''} ${c.schemaErrors.join(',')}`);
}
