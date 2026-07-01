import { main } from './app.ts';

main().catch((err) => {
	console.error('fatal:', err);
	process.exit(1);
});
