import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from '@selfxyz/core';
import { getAddress, isAddress } from 'viem';

const prisma = new PrismaClient();

// Define verification requirements (must match frontend)
const verification_config = {
  excludedCountries: [],
  ofac: false,
  minimumAge: 18,
};

// Create the configuration store
const configStore = new DefaultConfigStore(verification_config);

// Initialize the verifier
const selfBackendVerifier = new SelfBackendVerifier(
  process.env.NEXT_PUBLIC_SELF_SCOPE || 'snarkels-verification',
  process.env.NEXT_PUBLIC_SELF_ENDPOINT || 'https://snarkels.lol/api/verification/self',
  false,
  AllIds,
  configStore,
  'hex'
);

export async function POST(request: NextRequest) {
  try {
    console.log('=== VERIFICATION REQUEST START ===');
    console.log('Timestamp:', new Date().toISOString());
    
    let body;
    try {
      body = await request.json();
      console.log('✓ Request body parsed successfully');
    } catch (parseError) {
      console.error('✗ Failed to parse request body:', parseError);
      return NextResponse.json({
        status: "error",
        result: false,
        message: "Failed to parse request body",
        error: parseError instanceof Error ? parseError.message : 'Unknown parsing error'
      }, { status: 400 });
    }

    const { attestationId, proof, publicSignals, userContextData, userAddress } = body;

    // Log received data for debugging (remove sensitive data in production)
    console.log('=== REQUEST DATA ===');
    console.log('Has attestationId:', !!attestationId, 'Type:', typeof attestationId, 'Value:', attestationId);
    console.log('Has proof:', !!proof, 'Type:', typeof proof, 'Keys:', proof ? Object.keys(proof) : 'N/A');
    console.log('Has publicSignals:', !!publicSignals, 'Type:', typeof publicSignals, 'Length:', Array.isArray(publicSignals) ? publicSignals.length : 'N/A');
    console.log('Has userContextData:', !!userContextData, 'Type:', typeof userContextData, 'Length:', typeof userContextData === 'string' ? userContextData.length : 'N/A', 'Preview:', typeof userContextData === 'string' ? userContextData.substring(0, 50) : 'N/A');
    console.log('Has userAddress:', !!userAddress, 'Value:', userAddress);
    console.log('==================');

    // Verify required fields are present
    if (!proof || !publicSignals || !attestationId || !userContextData || !userAddress) {
      const missingFields = [];
      if (!attestationId) missingFields.push('attestationId');
      if (!proof) missingFields.push('proof');
      if (!publicSignals) missingFields.push('publicSignals');
      if (!userContextData) missingFields.push('userContextData');
      if (!userAddress) missingFields.push('userAddress');
      
      console.error('✗ MISSING REQUIRED FIELDS:', missingFields);
      console.error('Field status:', {
        proof: !!proof,
        publicSignals: !!publicSignals,
        attestationId: !!attestationId,
        userContextData: !!userContextData,
        userAddress: !!userAddress
      });
      
      return NextResponse.json({
        status: "error",
        result: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields: missingFields,
        debug: {
          proof: !!proof,
          publicSignals: !!publicSignals,
          attestationId: !!attestationId,
          userContextData: !!userContextData,
          userAddress: !!userAddress
        }
      }, { status: 400 });
    }
    
    console.log('✓ All required fields present');

    // Validate and normalize the user address
    console.log('=== ADDRESS VALIDATION ===');
    let normalizedAddress: string;
    try {
      console.log('Validating address:', userAddress);
      // Validate the address format
      if (!isAddress(userAddress)) {
        console.error('✗ Invalid address format:', userAddress);
        return NextResponse.json({
          status: "error",
          result: false,
          message: "Invalid user address format",
          providedAddress: userAddress
        }, { status: 400 });
      }
      // Normalize to checksum address then lowercase for database
      normalizedAddress = getAddress(userAddress).toLowerCase();
      console.log('✓ Address validated and normalized:', normalizedAddress);
    } catch (e) {
      console.error('✗ Address validation error:', e);
      console.error('Provided address:', userAddress);
      return NextResponse.json({
        status: "error",
        result: false,
        message: "Invalid user address format",
        error: e instanceof Error ? e.message : 'Unknown error',
        providedAddress: userAddress
      }, { status: 400 });
    }

    // Verify the proof
    console.log('=== PROOF VERIFICATION ===');
    console.log('Attestation ID:', attestationId);
    console.log('Proof structure:', {
      hasA: !!proof?.a,
      hasB: !!proof?.b,
      hasC: !!proof?.c,
      proofKeys: proof ? Object.keys(proof) : []
    });
    console.log('Public signals length:', Array.isArray(publicSignals) ? publicSignals.length : 'Not an array');
    console.log('User context data length:', typeof userContextData === 'string' ? userContextData.length : 'Not a string');
    
    let result;
    try {
      console.log('Calling selfBackendVerifier.verify()...');
      result = await selfBackendVerifier.verify(
        attestationId,    // Document type (1 = passport, 2 = EU ID card)
        proof,            // The zero-knowledge proof
        publicSignals,    // Public signals array
        userContextData   // User context data
      );
      console.log('✓ Verification call completed');
      console.log('Verification result:', {
        isValid: result.isValidDetails.isValid,
        isMinimumAgeValid: result.isValidDetails.isMinimumAgeValid,
        isOfacValid: result.isValidDetails.isOfacValid,
        details: result.isValidDetails,
        fullResult: JSON.stringify(result, null, 2)
      });
    } catch (verifyError) {
      console.error('✗ VERIFICATION ERROR:', verifyError);
      console.error('Error type:', verifyError instanceof Error ? verifyError.constructor.name : typeof verifyError);
      console.error('Error message:', verifyError instanceof Error ? verifyError.message : String(verifyError));
      console.error('Error stack:', verifyError instanceof Error ? verifyError.stack : 'N/A');
      
      return NextResponse.json({
        status: "error",
        result: false,
        message: "Proof verification failed",
        error: verifyError instanceof Error ? verifyError.message : 'Unknown verification error',
        errorType: verifyError instanceof Error ? verifyError.constructor.name : typeof verifyError,
        step: "verification"
      }, { status: 500 });
    }

    // Check if verification was successful
    if (result.isValidDetails.isValid) {
      console.log('✓ VERIFICATION SUCCESSFUL');
      // Verification successful - process the result
      const disclosedData = result.discloseOutput;
      console.log('=== DATABASE OPERATIONS ===');
      console.log('Disclosed data:', disclosedData);
      
      try {
        // Find or create user by wallet address
        console.log('Looking up user with address:', normalizedAddress);
        let user = await prisma.user.findUnique({
          where: { address: normalizedAddress }
        });
        console.log('User lookup result:', user ? `Found user ${user.id}` : 'User not found');

        if (!user) {
          // Create new user if they don't exist
          console.log('Creating new user...');
          user = await prisma.user.create({
            data: {
              address: normalizedAddress,
              isVerified: true,
              verificationMethod: 'self_protocol',
              verifiedAt: new Date(),
            }
          });
          console.log('✓ User created:', user.id);
        } else {
          // Update existing user's verification status
          console.log('Updating existing user verification status...');
          await prisma.user.update({
            where: { id: user.id },
            data: {
              isVerified: true,
              verificationMethod: 'self_protocol',
              verifiedAt: new Date(),
            }
          });
          console.log('✓ User verification updated');
        }

        // Save verification attempt - stringify proofData for SQLite compatibility
        console.log('Creating verification attempt record...');
        await prisma.verificationAttempt.create({
          data: {
            userId: user.id,
            verificationType: 'self_protocol',
            status: 'success',
            proofData: JSON.stringify({
              attestationId,
              disclosedData,
              verificationResult: result
            }),
            verifiedAt: new Date(),
          }
        });
        console.log('✓ Verification attempt saved');

        // Extract and save age and country data if available
        if (disclosedData) {
          const updateData: any = {};
          const data = disclosedData as any; // Type assertion for dynamic data
          
          // Extract age if available (check for minimumAge verification)
          if (data.minimumAge !== undefined) {
            // If minimumAge is verified as 18+, we know the user is at least 18
            updateData.dateOfBirth = new Date(Date.now() - (18 * 365 * 24 * 60 * 60 * 1000));
          }
          
          // Extract country if available - check multiple possible property names
          const country = data.issuingState || data.issuing_state || data.country;
          if (country) {
            updateData.country = country;
          }
          
          // Update user with extracted data
          if (Object.keys(updateData).length > 0) {
            await prisma.user.update({
              where: { id: user.id },
              data: updateData
            });
          }
        }

        return NextResponse.json({
          status: "success",
          result: true,
          credentialSubject: disclosedData,
          userId: user.id,
          message: "Verification successful and saved to database"
        });
      } catch (dbError) {
        console.error('✗ DATABASE ERROR:', dbError);
        console.error('Error type:', dbError instanceof Error ? dbError.constructor.name : typeof dbError);
        console.error('Error message:', dbError instanceof Error ? dbError.message : String(dbError));
        console.error('Error stack:', dbError instanceof Error ? dbError.stack : 'N/A');
        
        return NextResponse.json({
          status: "error",
          result: false,
          message: "Verification successful but failed to save to database",
          error: dbError instanceof Error ? dbError.message : 'Unknown database error',
          errorType: dbError instanceof Error ? dbError.constructor.name : typeof dbError,
          step: "database",
          credentialSubject: disclosedData,
        }, { status: 500 });
      }
    } else {
      // Verification failed
      console.error('✗ VERIFICATION FAILED');
      console.error('Validation details:', result.isValidDetails);
      console.error('Full result object:', JSON.stringify(result, null, 2));
      
      const errorDetails = result.isValidDetails as any;
      
      return NextResponse.json({
        status: "error",
        result: false,
        message: "Verification failed",
        errorCode: errorDetails.errorCode || 'VERIFICATION_FAILED',
        errorMessage: errorDetails.errorMessage || 'Proof verification failed',
        details: result.isValidDetails,
        fullResult: result,
        step: "validation"
      }, { status: 500 });
    }
  } catch (error: any) {
    console.error('✗ UNEXPECTED ERROR:', error);
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('Error message:', error instanceof Error ? error.message : String(error));
    console.error('Error stack:', error instanceof Error ? error.stack : 'N/A');
    console.error('=== VERIFICATION REQUEST END (ERROR) ===');
    
    return NextResponse.json({
      status: "error",
      result: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      step: "unknown"
    }, { status: 500 });
  }
  
  console.log('=== VERIFICATION REQUEST END (SUCCESS) ===');
}
