# Provider Discord non configuré

Supabase est accessible, la base est prête, mais l'authentification Discord n'est pas active.

## Étapes

1. Créez une application Discord via le Developer Portal : https://discord.com/developers/applications
2. Rendez-vous sur l'onglet OAuth2
3. Récupèrez `Client ID`, puis générez le `Client Secret` et récupérez le également.

![Discord Developer Portal](./install/supabase_6.png)

4. Dans Supabase > **Authentication > Providers > Discord**, activez le provider.

![Supabase Discord Auth](./install/supabase_7.png)

5. Collez `Client ID` et `Client Secret`
6. Récupérez le `Discord OAuth Redirect`.

![Supabase Discord Auth](./install/supabase_8.png)

7. Dans le Developer Portal Discord, ajoutez le callback Supabase dans Discord OAuth Redirects.

![Supabase Discord Auth](./install/supabase_9.png)

8. Ajoute l'URL GitHub Pages dans Supabase > **Authentication > URL Configuration**.

Ensuite clique sur **Réessayer**.
