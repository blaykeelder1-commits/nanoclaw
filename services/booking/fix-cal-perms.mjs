import { google } from "googleapis";

const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const auth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const cal = google.calendar({ version: "v3", auth });

const calendars = [
  { name: "RV Camper", id: "c_7ba6d46497500abce720f92671ef92bb8bbdd79e741f71d41c01084e6bb0d69c@group.calendar.google.com" },
  { name: "Car Hauler", id: "c_f92948a07076df3480b68fcaac0dd44cfc815ca9265999f709254dfca5fc64ad@group.calendar.google.com" },
  { name: "Landscaping", id: "c_684ca11a465fb336458c8d7dfadc9ec83265bce3b8657712d2fa10ea32cc627e@group.calendar.google.com" },
];

// First check current access level
for (const c of calendars) {
  try {
    const acl = await cal.acl.list({ calendarId: c.id });
    const rules = acl.data.items || [];
    const myRule = rules.find(r => r.scope?.value === key.client_email);
    console.log(`${c.name}: current role = ${myRule?.role || "none (freeBusyReader via settings?)"}`);
    console.log(`  All ACL entries: ${rules.map(r => r.scope?.value + "=" + r.role).join(", ")}`);
  } catch (err) {
    console.log(`${c.name}: ACL list failed: ${err.message}`);
    
    // Try to insert writer access directly
    try {
      await cal.acl.insert({
        calendarId: c.id,
        requestBody: {
          role: "writer",
          scope: { type: "user", value: key.client_email },
        },
      });
      console.log(`${c.name}: GRANTED writer access\!`);
    } catch (e2) {
      console.log(`${c.name}: grant failed: ${e2.message}`);
    }
  }
}
