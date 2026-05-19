# Atlas Tools CRM - Firebase Version

This version is a hosted Firebase web app.

It uses:

- Firebase Hosting for the application
- Cloud Firestore for customers and settings
- Firebase Authentication for staff login
- Google Maps JavaScript API for map, markers, geocoding and address autocomplete

## Required setup

1. Create a Firebase project.
2. Enable Firebase Authentication.
3. Enable Email/Password login.
4. Create at least one user in Firebase Authentication.
5. Create a Firestore database.
6. Enable Firebase Hosting.
7. Replace the placeholder values in `public/firebase-config.js`.
8. Update `.firebaserc` with your Firebase project ID.
9. Deploy.

## Install tools

```bash
npm install
npx firebase login
```

## Local test

```bash
npm run hosting
```

Open:

```text
http://127.0.0.1:5000
```

## Deploy

```bash
npm run deploy
```

## Google Maps key restrictions

Add these during local testing:

```text
http://localhost:5000/*
http://127.0.0.1:5000/*
```

After deployment, add your hosted domains:

```text
https://YOUR-PROJECT-ID.web.app/*
https://YOUR-PROJECT-ID.firebaseapp.com/*
https://crm.atlastools.co/*
```

Required Google APIs:

- Maps JavaScript API
- Geocoding API
- Places API
- Places API (New), if your Google Cloud console separates it

## Importing existing data

In the Settings tab, use:

- Import JSON to import the old Electron `customers.json`
- Import CSV to import a CSV customer list

The app will write imported customers to Firestore.


## v1.1.0 Firestore connection notes

This version changes Firestore initialisation to use long-polling fallback:

```js
initializeFirestore(firebaseApp, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false
});
```

This helps when business networks, antivirus software, proxies, or browsers block Firestore's normal streaming connection.

If you see `FirebaseError: Failed to get document because the client is offline`, check:

1. Firestore Database has been created in Firebase Console.
2. Cloud Firestore API is enabled in Google Cloud.
3. Your `firebaseConfig.projectId` matches the Firebase project you deployed to.
4. Authentication is enabled and the user is signed in.
5. Firestore rules allow signed-in users to read/write.
6. Browser/network is not blocking `firestore.googleapis.com`.
7. Wait 2-5 minutes after enabling APIs or creating Firestore.


## v1.2.0 Google Maps startup fix

This version changes the Google Maps loader to use Google's callback parameter:

```text
callback=__atlasGoogleMapsLoaded
```

It also waits up to 10 seconds for `google.maps.Map`, `google.maps.Geocoder`, and `google.maps.InfoWindow` before initialising the map. This fixes the issue where the map only worked after clicking **Reload Map** in Settings.


## v1.2.1 configured files

This build includes the supplied `public/firebase-config.js` and `.firebaserc` files for the Atlas Tools Firebase project.

Confirm Google Maps HTTP referrer restrictions include:

```text
https://atlas-tools-crm.web.app/*
https://atlas-tools-crm.firebaseapp.com/*
http://localhost:5000/*
http://127.0.0.1:5000/*
```


## v1.3.0 notes

The Google Maps API key display/input has been removed from the Settings tab. The key is still loaded from:

```text
public/firebase-config.js
```

Important: any API key used by frontend browser JavaScript is public to users of the site. This is normal for Google Maps browser keys. Security must be handled using Google Cloud API restrictions, especially HTTP referrer restrictions and API restrictions.


## v1.3.1 notes

Fixes a login-screen blocking error caused by an event listener binding to a Settings element that was removed with the Google Maps API key field. Event bindings are now null-safe.

Also wraps the login fields in a `<form>` and allows `https://www.gstatic.com` in `connect-src` to stop Firebase source-map CSP noise during debugging.


## v1.4.0 notes

- Removed the whole Google Maps settings panel.
- Added the logged-in user's display name beside `Firestore connected`.
- The display name comes from Firebase Auth `displayName`; if blank, the app formats the email prefix.
- Added logo/favicon support using:
  - `public/assets/atlas-logo.svg`
  - `public/assets/favicon.svg`

To use the real Atlas Tools logo, replace those files with your own logo files and keep the same filenames, or send the logo file and the project can be regenerated with it embedded.


## v1.5.0 logo update

This build uses the supplied logo files:

- Browser favicon: `public/assets/favicon.png`
- ICO fallback: `public/assets/favicon.ico`
- Apple touch icon: `public/assets/apple-touch-icon.png`
- Header/login logo: `public/assets/atlas-logo-header.png`
- Original supplied logo retained as: `public/assets/atlas-logo.jpg`

After deployment, hard refresh the browser. Favicons are aggressively cached, so it may take a while to update in the tab unless the browser cache is cleared.
