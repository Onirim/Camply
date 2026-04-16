# Connexion Supabase non disponible

Camply n'arrive pas à communiquer avec Supabase.

## Etapes d'installation

1. Inscrivez-vous sur https://supabase.com/, c'est gratuit !
2. Créez votre organisation, puis votre projet.
3. Rendez-vous dans le menu de connexion et allez chercher votre URL et votre clé Supabase.

![Finding supabase URL and Key](./install/supabase_1.png)

![Finding supabase URL and Key](./install/supabase_2.png)

4. Sur Github, éditez le fichier `supabase-client.js` et entrez le `SUPABASE_URL` et `SUPABASE_KEY` récupérés précédemment.
5. Dans Supabase > **Authentication > URL Configuration**, ajoutez votre URL GitHub Pages.
   
![Adding Github Pages URL](./install/supabase_3.png)

Ensuite, cliquez sur **Réessayer**.
