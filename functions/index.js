const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp(functions.config().firebase);
const nodemailer = require("nodemailer");
const sanitizeHtml = require("sanitize-html");

// Configure mail transport
const mailTransport = nodemailer.createTransport({
  service: "gmail",
  // TODO: To simplify initial setup, we are currently using a standard
  //       gmail account for sending transactional emails.
  //       This email account is configured to allow "Less secure apps"
  //       which means we only need to authenticate with the standard
  //       username and password of the account to send email. Google
  //       is perminantly _disabling_ this functionality on May 30th,
  //       2022 for all personal Gmail accounts. We will want to
  //       transition away from using this temporary gmail account
  //       before then, but if we still have cause to use this account
  //       see https://nodemailer.com/usage/using-gmail/ for potential
  //       workarounds.
  auth: {
    user: process.env.TEMPORARY_GMAIL_EMAIL_ADDRESS,
    pass: process.env.TEMPORARY_GMAIL_EMAIL_PASSWORD,
  },
});

const moment = require("moment");
require("moment-timezone");
const db = admin.firestore();

exports.helloWorld = functions.https.onRequest((request, response) => {
  functions.logger.info("Hello logs!", { structuredData: true });
  response.send("Hello from Firebase!");
});

// Pass in the channelId and userId to fetch all mentioned posts of the user in the channel
const getMentionedPostsInChannel = async (channelId, currentUserId) =>
  (
    await db
      .collection(`posts`)
      .where(`channels.${channelId}.channelName`, "!=", false)
      .get()
  ).docs
    .map((doc) => doc.data())
    .filter((doc) => currentUserId in doc.mentions);

// Fetch all other users except the current user (you don't want to see notifications of your own posts)
const getOtherUsers = async (currentUserId) =>
  await db.collection("users").where("id", "!=", currentUserId).get();

// Get inbox priority of post
const getInboxPriority = (user, post) => {
  if (post.text.includes(`@@${user.name}`)) return 300;
  if (user.id in post.mentions) return 400;
  return 500;
};

// Add post to inbox of user
const addToInbox = (user, post) => {
  const postToNotify = { ...post, inboxPriority: getInboxPriority(user, post) };

  db.collection(`users/${user.id}/inbox`)
    .doc(post.id)
    .set(postToNotify)
    .then(() => {
      functions.logger.info(
        "Post added to inbox successfully!, userId => ",
        user.id,
        "postId => ",
        post.id
      );
    });
};

// Edit a post in the inbox of a user
const editInboxPost = (user, post, key, value) => {
  db.collection(`users/${user.id}/inbox`)
    .doc(post.id)
    .update({
      [key]: value,
    })
    .then(() => {
      functions.logger.info(
        "Inbox post updated successfully!, userId => ",
        user.id,
        "postId => ",
        post.id,
        ",",
        key,
        "changed to =>",
        value
      );
    });
};

// Check the notification preference for the specific channel of that post, and notify/(not notify) in inbox
const checkNotificationPreference = async (user, post) => {
  const preferences = user.notifyPreferences || {};

  const channelPreference = preferences[post.channelId];
  // If there is no valid channel preference, notify only if the user is mentioned in the post
  if (!channelPreference && user.id in post.mentions) {
    return addToInbox(user, post);
  }

  // If preference is `involved`, notify for every post where the user has been mentioned before in that channel
  if (channelPreference === "involved") {
    // First, we get all mentioned posts in that channel

    const channelPosts = await getMentionedPostsInChannel(
      post.channelId,
      user.id
    );

    // If there are any mentioned posts, then add to inbox
    if (channelPosts.length) {
      return addToInbox(user, post);
    }
  }

  // If preference is `all`, notify for every post
  if (channelPreference === "all") {
    return addToInbox(user, post);
  }
};

exports.onPostUpdated = functions.firestore
  .document("posts/{postId}")
  .onUpdate(async (change) => {
    const previousPost = change.before.data();
    const post = change.after.data();

    const couldNotSend =
      !previousPost.sentAt || previousPost.sentAt === "pending";

    const canNowSend = post.sentAt && post.sentAt !== "pending";

    // Send to inboxes only if the post is no longer a draft and `sentAt` is no longer `pending`
    if (couldNotSend && canNowSend) {
      const users = await getOtherUsers(post.creatorId);

      return users.forEach((doc) =>
        checkNotificationPreference(doc.data(), post)
      );
    }
  });

exports.submitPost = functions.https.onCall(async (data) => {
  // Get post details
  const { postId, postPayload } = data;

  const sanitizedText = sanitizeHtml(postPayload.text);

  return db
    .collection(`posts`)
    .doc(postId)
    .set({
      ...postPayload,
      text: sanitizedText,
    })
    .then(() => {
      functions.logger.info(
        "Post submitted successfully!, postId => ",
        postId,
        ",",
        "sanitized text =>",
        sanitizedText
      );
    });
});

// Resolves a promise after a specified time
const waitUntil = (time) => {
  return new Promise((res) => {
    setTimeout(() => {
      res("Done!");
    }, time * 1000);
  });
};

exports.handleTriageUntil = functions.https.onCall(async (data, context) => {
  await waitUntil(data.time);

  return addToInbox(context.auth, data.post);
});

exports.scheduledInboxTriageUpdate = functions.pubsub
  .schedule("every 1 minutes")
  .onRun(async () => {
    // Fetches all users,
    const users = await db.collection("users").get();

    return users.forEach(async (doc) => {
      const user = doc.data();

      // Then gets all posts in the user's inbox where the `triagedUntil` timestamp is lesser than the current timestamp (now)
      const usersCurrentTriages = await db
        .collection(`users/${user.id}/inbox`)
        .where("triagedUntil", "<", moment(new Date()).valueOf())
        .get();

      usersCurrentTriages.forEach((doc) => {
        const post = doc.data();

        // and finally, it updates all such posts by setting the `triagedUntil` value to null
        editInboxPost(user, post, "triagedUntil", null);
      });
    });
  });

exports.sendMailToInvitee = functions.https.onCall(async (data) => {
  // Get mailing details
  const {
    inviteeEmail,
    senderEmail,
    senderName,
    workspaceId,
    workspaceName,
    // Because firebase emulators are not currently setup for this
    // project, all development is sharing the same hosted Firebase
    // instance. Generally, when devs are testing, we don't want emails
    // to be going out (e.g. someone might be entering a inviteeEmail
    // that they don't want to _actually_ receive an email). For this
    // reason, devs need to specify that they actually want an email to
    // we sent. This will be controlled by client app env variable.
    // TODO: when emulation support is added for devs, transition to that
    //       and remove this.
    FORCE_ACTUAL_EMAIL,
  } = data;

  // Prepare mail content
  const mailOptions = {
    from: `Levels Health Comms <${process.env.TEMPORARY_GMAIL_EMAIL_ADDRESS}>`,
    to: inviteeEmail,
    subject: `Come join ${senderName} on the "${workspaceName}" workspace! - Comms`,
    html: `<p style="font-size: 16px; font-style: Inter, sans-seif;">Hello,</p>
            <p style="font-size: 16px;">You've been invited to a Comms workspace by ${senderName} (${senderEmail})</p>
            <p style="font-size: 16px;">To accept this invitation, please click on the link below:</p>
            <p style="font-size: 16px;">https://commsbylevels.com/workspaces?id=${workspaceId}&name=${encodeURIComponent(
      workspaceName
    )}</p>
            <br/>
            <p style="font-size: 16px;">Best Regards,</p>
            <p style="font-size: 16px;">The Comms Team</p>
          `, // email content in HTML
  };

  if (FORCE_ACTUAL_EMAIL) {
    console.log("actually sending invitation email");
    await mailTransport.sendMail(mailOptions);
  } else {
    console.log(
      "FORCE_ACTUAL_EMAIL !== true, not actually sending invitation email"
    );
  }

  return await new Promise((resolve) => {
    return resolve({
      result: "Email sent to: " + inviteeEmail,
    });
  });
});
