// Configuração do Firebase.
// Pegue estes valores em: Console do Firebase → Configurações do projeto → Seus apps → App da Web.
// Esses dados NÃO são secretos: quem protege os dados são as regras do Firestore (firestore.rules).
export const firebaseConfig = {
  apiKey: "COLE_AQUI",
  authDomain: "SEU-PROJETO.firebaseapp.com",
  projectId: "SEU-PROJETO",
  storageBucket: "SEU-PROJETO.appspot.com",
  messagingSenderId: "000000000000",
  appId: "COLE_AQUI"
};

// E-mails que podem entrar (em minúsculas) e o nome que aparece no app.
// Use os MESMOS e-mails no arquivo firestore.rules.
export const USERS = {
  "seu-email@exemplo.com": "Leandro",
  "email-da-esposa@exemplo.com": "Esposa"
};
