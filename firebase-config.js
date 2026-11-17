// Configuração do Firebase.
// Pegue estes valores em: Console do Firebase → Configurações do projeto → Seus apps → App da Web.
// Esses dados NÃO são secretos: quem protege os dados são as regras do Firestore (firestore.rules).
export const firebaseConfig = {
  apiKey: "AIzaSyD23x3BEXUuvSk-I5s3M2dvTZmHJ0XDYFw",
  authDomain: "compras-3f02b.firebaseapp.com",
  projectId: "compras-3f02b",
  storageBucket: "compras-3f02b.firebasestorage.app",
  messagingSenderId: "923199326499",
  appId: "1:923199326499:web:741c98c0a924aaad0f6496"
};

// E-mails que podem entrar (em minúsculas) e o nome que aparece no app.
// Use os MESMOS e-mails no arquivo firestore.rules.
export const USERS = {
  "leandrohacarvalho@gmail.com": "Leandro",
  "strandrade@gmail.com": "Stephany"
};
