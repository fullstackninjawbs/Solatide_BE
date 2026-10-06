import { exec } from 'child_process';
import path from 'path';

let rebuildTimeout: NodeJS.Timeout | null = null;
let isRebuilding = false;

/**
 * Triggers a debounced rebuild and atomic deployment of the static storefront
 * (Vite build, prerendering, SEO validation, file smoke tests, and atomic symlink switch).
 * This function waits 10 seconds before running to prevent multiple builds 
 * from firing simultaneously when a user saves multiple items quickly.
 */
export const triggerStorefrontRebuild = () => {
    console.log('🔄 Storefront rebuild requested. Waiting 10 seconds to debounce...');
    
    if (rebuildTimeout) {
        clearTimeout(rebuildTimeout);
    }

    rebuildTimeout = setTimeout(() => {
        if (isRebuilding) {
            console.log('⏳ A rebuild is already in progress. Retrying in 10 seconds...');
            triggerStorefrontRebuild();
            return;
        }

        console.log('🚀 Starting atomic storefront deployment (deploy-store.sh)...');
        isRebuilding = true;

        // Path to the frontend directory
        // Use CLIENT_DIR from env if available (useful for production), otherwise fallback to the relative path in the repo.
        const clientDir = process.env.CLIENT_DIR || path.join(__dirname, '../../../Client');

        exec('bash scripts/deploy-store.sh', { cwd: clientDir }, (error, stdout, stderr) => {
            isRebuilding = false;
            
            if (error) {
                console.error(`❌ Atomic storefront deployment failed: ${error.message}`);
                return;
            }
            if (stderr && stderr.includes('ERR!')) {
                console.error(`⚠️ Storefront deployment had stderr: ${stderr}`);
            }
            
            console.log(`✅ Atomic storefront deployment completed successfully!`);
        });

    }, 10000); // 10 second debounce
};
