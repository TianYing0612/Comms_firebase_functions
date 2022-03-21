## Functions

This is where all the cloud functions are created.

Functions which are not exported are considered reusable helper functions that can be used by other exported function as the need arises. Mostly used for querying, editing or adding to the database

### To install dependencies into the cloud functions,

- cd to the `/functions` folder from the CLI
- run npm install _package-name_

### To deploy changes made in the `functions/index` file,

- run `firebase deploy --only functions`

You can access the firebase functions console at https://console.firebase.google.com/project/comms-342893/functions
