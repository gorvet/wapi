//db.js
import mysql from 'mysql2';

const connection = mysql.createConnection({
  host: 'localhost',
    user:  process.env.DB_USER,
    password: process.env.DB_PASWD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 500,  // Limitamos el número de conexiones concurrentes
    queueLimit: 0,
    connectTimeout: 10000, // Tiempo de espera en milisegundos (10 segundos) para conectar al servidor MySQL
});

connection.connect(err => {
  if (err) {
    console.error('Error connecting to the database: ', err);
  } else {
    console.log('Connected to the MySQL database.');
  }
});

export connection;
