import { exec } from 'child_process';
import path from 'path';

let rebuildTimeout: NodeJS.Timeout | null = null;
let isRebuilding = false;

/**
 * Triggers a debounced rebuild of the static storefront (prerendering & sitemap generation).
 * This function waits 10 seconds before running the build to prevent multiple builds 
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

        console.log('🚀 Starting storefront rebuild (SEO and sitemap generation)...');
        isRebuilding = true;

        // Path to the frontend directory
        // Use CLIENT_DIR from env if available (useful for production), otherwise fallback to the relative path in the repo.
        const clientDir = process.env.CLIENT_DIR || path.join(__dirname, '../../../Client');

        exec('npm run build:store', { cwd: clientDir }, (error, stdout, stderr) => {
            isRebuilding = false;
            
            if (error) {
                console.error(`❌ Storefront rebuild failed: ${error.message}`);
                return;
            }
            if (stderr && stderr.includes('ERR!')) {
                console.error(`⚠️ Storefront rebuild had stderr: ${stderr}`);
                // Continue, as some warnings output to stderr
            }
            
            console.log(`✅ Storefront rebuild completed successfully!`);
            // console.log(`Build Output: ${stdout}`);
        });

    }, 10000); // 10 second debounce
};
