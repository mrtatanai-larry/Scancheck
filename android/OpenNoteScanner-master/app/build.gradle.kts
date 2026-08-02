plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("kapt")
}

android {
    compileSdk = 34
    namespace = "com.todobom.opennotescanner"
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }
    defaultConfig {
        applicationId = "com.todobom.opennotescanner"
        minSdk = 21
        targetSdk = 31
        versionCode = 36
        versionName = "1.0.36"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    flavorDimensions += "version"
    productFlavors {
        create("fdroid") {
            dimension = "version"
            applicationIdSuffix = ""
            versionNameSuffix = "-fdroid"
        }
        create("gplay") {
            dimension = "version"
            applicationIdSuffix = ""
            versionNameSuffix = "-gplay"
        }
    }
    lint {
        abortOnError = false
    }
}

dependencies {
    implementation(fileTree(mapOf("include" to listOf("*.jar"), "dir" to "libs")))

    implementation("androidx.core:core-ktx:1.9.0")
    implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.8.10")

    implementation("androidx.exifinterface:exifinterface:1.3.6")
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.fragment:fragment-ktx:1.5.5")
    implementation("androidx.activity:activity-compose:1.7.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.6.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.6.2")
    implementation(platform("androidx.compose:compose-bom:2023.08.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    implementation("com.google.android.material:material:1.8.0")
    implementation("androidx.room:room-runtime:2.5.2")
    implementation("androidx.room:room-ktx:2.5.2")
    kapt("androidx.room:room-compiler:2.5.2")
    implementation("androidx.work:work-runtime-ktx:2.8.1")
    implementation("com.google.mlkit:text-recognition:16.0.0")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.10.0")
    implementation("com.google.zxing:core:3.5.1")
    implementation("com.github.ctodobom:OpenCV-3.1.0-Android:9e00ee4218ca0c9e60a905c9f09bf499f9dc5115")
    implementation("com.github.ctodobom:drag-select-recyclerview:0.3.4.ctodobom.sections")
    implementation("com.github.allgood:Android-Universal-Image-Loader:717a00c")
    implementation("com.github.ctodobom:FabToolbar:3c5f0e0ff1b6d5089e20b7da7157a604075ae943")
    implementation("com.github.matomo-org:matomo-sdk-android:4.1.4")
    implementation("com.github.MikeOrtiz:TouchImageView:3.3")

    val itextpdf_version = "7.2.5"
    implementation("com.itextpdf:kernel:$itextpdf_version")
    implementation("com.itextpdf:layout:$itextpdf_version")
    implementation("com.itextpdf:io:$itextpdf_version")
}
