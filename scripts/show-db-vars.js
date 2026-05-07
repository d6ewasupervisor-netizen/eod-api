const keys = Object.keys(process.env).filter(k =>
  k.includes('DATABASE') || k.includes('PG') || k.includes('POSTGRES')
);
process.stdout.write(keys.join('\n') + '\n');
process.exit(0);
