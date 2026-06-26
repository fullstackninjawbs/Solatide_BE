import('dotenv/config');
import('@tagadapay/node-sdk').then(({ default: Tagada }) => {
  const tagada = new Tagada(process.env.TAGADA_API_KEY_SANDBOX);

  async function testTagada() {
    try {
      const session = await tagada.checkout.createSession({
        storeId: process.env.TAGADA_STORE_ID,
        items: [
          {
            variantId: 'product_6258aae7c920',
            quantity: 1,
          }
        ],
        currency: 'AUD',
        draft: true, // Passing draft: true for staging funnels
      });
      console.log('Success:', session);
    } catch (err) {
      console.log('Error:', err.message);
    }
  }

  testTagada();
});
