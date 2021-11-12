import axios from "axios";
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {AuthorizationCode, ModuleOptions} from "simple-oauth2";
import serviceAccount from "./service-account.json";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
});

export const firebaseToken= functions.https.onRequest(
    async (request, response) => {
      try {
        if (request.method != "POST") {
          response
              .status(400)
              .send({error: "Invalid HTTP method"});
          return;
        }

        const stravaRefreshToken = request.query["strava_refresh_token"];
        if (!stravaRefreshToken) {
          response
              .status(400)
              .send({error: "Invalid Strava token"});
          return;
        }

        const oauthConfig: ModuleOptions = {
          client: {
            id: functions.config().strava.client_id,
            secret: functions.config().strava.client_secret,
          },
          auth: {
            tokenHost: "https://www.strava.com",
            tokenPath: "/oauth/token",
          },
        };
        const oauthClient = new AuthorizationCode(oauthConfig);
        const token = oauthClient.createToken({
          refresh_token: stravaRefreshToken,
        });
        const accessToken = await token.refresh({
          client_id: oauthConfig.client.id,
          client_secret: oauthConfig.client.secret,
        });

        const axiosInstance = axios.create({
          headers: {
            "Authorization": "Bearer " + accessToken.token.access_token,
          },
        });
        const athleteResponse = await axiosInstance.get("https://www.strava.com/api/v3/athlete");
        const athlete = athleteResponse.data;

        const firebaseUserId = "strava:" + athlete.id;
        const databaseTask = admin.firestore()
            .collection("users").doc(firebaseUserId).set({
              access_token: accessToken.token.access_token,
              refresh_token: accessToken.token.refresh_token,
            });
        const userCreationTask = admin.auth().updateUser(firebaseUserId, {
          displayName: athlete.firstname,
          photoURL: athlete.profile,
        }).catch((error) => {
          if (error.code === "auth/user-not-found") {
            return admin.auth().createUser({
              uid: firebaseUserId,
              displayName: athlete.firstname,
              photoURL: athlete.profile,
            });
          }
          throw error;
        });
        await Promise.all([userCreationTask, databaseTask]);

        const firebaseCustomToken = await admin.auth()
            .createCustomToken(firebaseUserId);

        response.send({
          firebaseCustomToken: firebaseCustomToken,
        });
      } catch (error) {
        functions.logger.error(error);
        response
            .status(500)
            .send({error: "Unhandled error"});
      }
    });
